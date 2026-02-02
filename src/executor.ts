import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { isLiveTradingEnabled } from './notifier.js';
import type { DipOpportunity, Position, TradeResult } from './types.js';

const log = createChildLogger('executor');

// CLOB Client host URL
const CLOB_HOST = 'https://clob.polymarket.com';

// Helper to check if we should use paper trading
function isPaperMode(): boolean {
  return !isLiveTradingEnabled();
}

// Paper trading stats
let paperStats = {
  totalTrades: 0,
  totalVolume: 0,
  simulatedProfit: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clobClient: any = null;

// Will be set on init from the SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Side: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let OrderType: any;

export async function initExecutor(): Promise<void> {
  // Skip SDK initialization in paper trading mode
  if (isPaperMode()) {
    log.info('📝 PAPER TRADING MODE - SDK initialization skipped');
    return;
  }

  try {
    // Dynamic import of required modules
    const clobModule = await import('@polymarket/clob-client');
    const { ClobClient, Side: SideEnum, OrderType: OrderTypeEnum } = clobModule;
    // Dynamic import for ESM compatibility
    const ethersModule = await import('ethers');
    const { Wallet } = ethersModule;

    // Set SDK enums
    Side = SideEnum;
    OrderType = OrderTypeEnum;

    // Validate API credentials
    if (!config.clobApi.key || !config.clobApi.secret || !config.clobApi.passphrase) {
      throw new Error('Missing CLOB API credentials. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
    }

    // Create wallet signer from private key
    const signer = new Wallet(config.privateKey);
    const walletAddress = await signer.getAddress();

    log.info({ walletAddress }, 'Initializing Polymarket CLOB client');

    // Initialize CLOB client with credentials
    const apiCreds = {
      key: config.clobApi.key,
      secret: config.clobApi.secret,
      passphrase: config.clobApi.passphrase,
    };

    // ClobClient constructor: (host, chainId, signer, creds, signatureType)
    // signatureType: 0 = EOA (standard wallet signature)
    // This worked in commit ed5aae96 - no funderAddress needed
    clobClient = new ClobClient(
      CLOB_HOST,
      config.chainId,
      signer,
      apiCreds,
      0 // EOA signature type
    );

    log.info('✅ Polymarket CLOB client initialized - REAL TRADING ENABLED');

  } catch (error) {
    log.error({ error }, 'Failed to initialize Polymarket CLOB client');
    throw error;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getClobClient(): any {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initExecutor() first.');
  }
  return clobClient;
}

// Execute a dip arbitrage trade (buy both UP and DOWN)
export async function executeDipTrade(
  opportunity: DipOpportunity,
  sizeUp: number,
  sizeDown: number,
  tokenIdUp: string,
  tokenIdDown: string
): Promise<{ success: boolean; position?: Partial<Position>; error?: string; latencyMs?: number }> {
  const positionId = generatePositionId();
  const executionStart = performance.now();

  // Calculate detection latency (time from dip detection to execution start)
  const detectionLatency = opportunity.detectedAt ? executionStart - opportunity.detectedAt : undefined;

  log.info(
    {
      market: opportunity.market,
      sizeUp,
      sizeDown,
      askUp: opportunity.askUp,
      askDown: opportunity.askDown,
      paperMode: isPaperMode(),
      detectionLatencyMs: detectionLatency?.toFixed(2),
    },
    isPaperMode() ? '📝 PAPER TRADE executing' : 'Executing dip trade'
  );

  // Paper trading mode - simulate the trade
  if (isPaperMode()) {
    return executePaperTrade(opportunity, sizeUp, sizeDown, positionId, executionStart);
  }

  // Real trading mode - using CLOB client

  try {
    // Execute both orders as FAK (Fill-And-Kill) to capture partial fills
    // FAK fills as much as possible at best available prices, cancels unfilled portion
    const [resultUp, resultDown] = await Promise.all([
      executeOrder(tokenIdUp, 'BUY', sizeUp, 'FAK'),
      executeOrder(tokenIdDown, 'BUY', sizeDown, 'FAK'),
    ]);

    // Check if both orders succeeded (at least partially with FAK)
    if (!resultUp.success || !resultDown.success) {
      const error = resultUp.error ?? resultDown.error ?? 'Unknown error';
      log.warn({ resultUp, resultDown }, 'Trade partially or fully failed');

      // With FAK orders, partial fills are possible
      // If one side filled and other didn't, we have an imbalanced position
      // For now, we consider this a failure - the filled side will remain as a position

      return { success: false, error };
    }

    const actualCostUp = (resultUp.filledPrice ?? opportunity.askUp) * (resultUp.filledSize ?? sizeUp);
    const actualCostDown = (resultDown.filledPrice ?? opportunity.askDown) * (resultDown.filledSize ?? sizeDown);
    const totalCost = actualCostUp + actualCostDown;

    // Fee rate based on market timeframe (0% for 1h, 3% for 15m)
    const feeRate = config.feeRates?.[config.marketTimeframe] ?? 0.03;
    const estimatedFees = totalCost * feeRate;

    const position: Partial<Position> = {
      id: positionId,
      market: opportunity.market,
      openedAt: Date.now(),
      status: 'open',
      costUp: resultUp.filledPrice ?? opportunity.askUp,
      costDown: resultDown.filledPrice ?? opportunity.askDown,
      sizeUp: resultUp.filledSize ?? sizeUp,
      sizeDown: resultDown.filledSize ?? sizeDown,
      totalCost,
      expectedProfit: 1.0 * Math.min(resultUp.filledSize ?? sizeUp, resultDown.filledSize ?? sizeDown) - totalCost - estimatedFees,
      fees: estimatedFees,
    };

    log.info(
      {
        positionId,
        totalCost: totalCost.toFixed(2),
        expectedProfit: position.expectedProfit?.toFixed(2),
      },
      '✅ Trade executed successfully'
    );

    return { success: true, position };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ error }, 'Trade execution failed');
    return { success: false, error: errorMsg };
  }
}

// Paper trading simulation
async function executePaperTrade(
  opportunity: DipOpportunity,
  sizeUp: number,
  sizeDown: number,
  positionId: string,
  executionStart: number
): Promise<{ success: boolean; position?: Partial<Position>; error?: string; latencyMs?: number }> {
  // Simulate small random slippage (0-1%)
  const slippage = 1 + (Math.random() * 0.01);

  const actualCostUp = opportunity.askUp * sizeUp * slippage;
  const actualCostDown = opportunity.askDown * sizeDown * slippage;
  const totalCost = actualCostUp + actualCostDown;

  // Fee rate based on market timeframe (0% for 1h, 3% for 15m)
  const feeRate = config.feeRates?.[config.marketTimeframe] ?? 0.03;
  const estimatedFees = totalCost * feeRate;

  // Simulate occasional failed trades (5% chance)
  if (Math.random() < 0.05) {
    log.warn({ market: opportunity.market }, '📝 PAPER: Simulated trade failure (5% random)');
    return { success: false, error: 'Simulated: Order book changed before execution' };
  }

  // Simulate network latency for paper trading (50-150ms)
  const simulatedNetworkLatency = 50 + Math.random() * 100;
  await new Promise(resolve => setTimeout(resolve, simulatedNetworkLatency));

  const executionEnd = performance.now();
  const executionLatency = executionEnd - executionStart;
  const totalLatency = opportunity.detectedAt ? executionEnd - opportunity.detectedAt : executionLatency;

  const shares = Math.min(sizeUp, sizeDown);
  const expectedProfit = (1.0 * shares) - totalCost - estimatedFees;

  const position: Partial<Position> = {
    id: positionId,
    market: opportunity.market,
    openedAt: Date.now(),
    status: 'open',
    costUp: opportunity.askUp * slippage,
    costDown: opportunity.askDown * slippage,
    sizeUp,
    sizeDown,
    totalCost,
    expectedProfit,
    fees: estimatedFees,
    executionLatency: Math.round(executionLatency),
    totalLatency: Math.round(totalLatency),
  };

  // Update paper stats
  paperStats.totalTrades++;
  paperStats.totalVolume += totalCost;
  paperStats.simulatedProfit += expectedProfit;

  log.info(
    {
      positionId,
      totalCost: totalCost.toFixed(2),
      expectedProfit: expectedProfit.toFixed(2),
      latencyMs: totalLatency.toFixed(1),
      paperStats: {
        trades: paperStats.totalTrades,
        volume: paperStats.totalVolume.toFixed(2),
        profit: paperStats.simulatedProfit.toFixed(2),
      },
    },
    '📝 PAPER TRADE executed successfully'
  );

  // Simulate position resolution after random time (5-15 min)
  const resolveDelay = 5 * 60 * 1000 + Math.random() * 10 * 60 * 1000;
  setTimeout(() => {
    const outcome = Math.random() > 0.5 ? 'UP' : 'DOWN';
    log.info(
      { positionId, outcome, profit: expectedProfit.toFixed(2) },
      '📝 PAPER POSITION resolved'
    );
  }, resolveDelay);

  return { success: true, position, latencyMs: totalLatency };
}

export function getPaperStats() {
  return { ...paperStats };
}

async function executeOrder(
  tokenId: string,
  side: 'BUY' | 'SELL',
  amount: number,
  orderType: 'FOK' | 'FAK' | 'GTC'
): Promise<TradeResult> {
  const client = getClobClient();

  try {
    log.debug(
      { tokenId: tokenId.substring(0, 16) + '...', side, amount, orderType },
      'Executing CLOB order'
    );

    // Fee rate in basis points - 0 for hourly markets (free trading)
    const feeRateBps = 0;

    // Execute market order via CLOB
    const result = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: amount, // Amount in USDC
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        feeRateBps,
      },
      { negRisk: false, tickSize: '0.01' },
      orderType === 'FOK' ? OrderType.FOK : orderType === 'FAK' ? OrderType.FAK : OrderType.GTC
    );

    // Check for errors - both errorMsg and HTTP error status codes
    const httpStatus = (result as { status?: number }).status;
    if (result.errorMsg || (httpStatus && httpStatus >= 400)) {
      const errorMessage = result.errorMsg || `HTTP ${httpStatus}`;
      log.error({ result, httpStatus }, `❌ CLOB order FAILED: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }

    log.info(
      {
        orderId: result.orderID,
        txHash: result.transactionHash,
        status: result.status,
      },
      '✅ CLOB order executed'
    );

    return {
      success: true,
      orderId: result.orderID ?? result.transactionHash,
      filledSize: result.filledAmount ?? amount, // FAK may have partial fills
      filledPrice: result.avgPrice ?? undefined, // Actual fill price if available
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ error, tokenId: tokenId.substring(0, 16) + '...' }, 'CLOB order failed');
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// Get current orderbook for a token
export async function getOrderbook(tokenId: string) {
  const client = getClobClient();
  const book = await client.getOrderBook(tokenId);

  return {
    bids: book.bids.map((b: { price: string; size: string }) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
    asks: book.asks.map((a: { price: string; size: string }) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
  };
}

// Get midpoint price
export async function getMidpoint(tokenId: string): Promise<number> {
  const client = getClobClient();
  const midpoint = await client.getMidpoint(tokenId);
  return parseFloat(midpoint);
}

function generatePositionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pos_${timestamp}_${random}`;
}

// Check if we can execute (CLOB client is ready or paper mode)
export function isReady(): boolean {
  return isPaperMode() || clobClient !== null;
}
