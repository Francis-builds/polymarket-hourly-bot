import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { isLiveTradingEnabled } from './notifier.js';
import { getMaxTotalCost } from './runtime-config.js';
import { initPresigner, stopPresigner, getPresignedOrder, postPresignedOrder } from './order-presigner.js';
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

    // ClobClient constructor: (host, chainId, signer, creds, signatureType, funder)
    //
    // signatureType values (configurable via POLYMARKET_SIGNATURE_TYPE):
    //   0 = EOA (standalone wallet, funds in same address as signer)
    //   1 = POLY_PROXY (Magic Link / email login)
    //   2 = GNOSIS_SAFE (MetaMask via Polymarket.com - proxy wallet holds funds)
    const signatureType = config.signatureType;
    const funderAddress = config.proxyWalletAddress;

    // Validate funder address requirement for non-EOA signature types
    if (signatureType !== 0 && !funderAddress) {
      throw new Error(
        `Missing POLYMARKET_PROXY_ADDRESS. Required for signatureType=${signatureType}. ` +
        'Set it to your proxy wallet address from Polymarket profile.'
      );
    }

    const signatureTypeNames = ['EOA', 'POLY_PROXY', 'GNOSIS_SAFE'];
    log.info(
      { walletAddress, funderAddress, signatureType, signatureTypeName: signatureTypeNames[signatureType] },
      `Initializing CLOB client (${signatureTypeNames[signatureType]} mode)`
    );

    clobClient = new ClobClient(
      CLOB_HOST,
      config.chainId,
      signer,
      apiCreds,
      signatureType,
      signatureType !== 0 ? funderAddress : undefined
    );

    log.info('✅ Polymarket CLOB client initialized - REAL TRADING ENABLED');

    // Initialize order pre-signer for reduced latency
    initPresigner(clobClient, Side);

  } catch (error) {
    log.error({ error }, 'Failed to initialize Polymarket CLOB client');
    throw error;
  }
}

export { stopPresigner };

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
  const orderStart = performance.now();

  // Calculate limit prices with 2¢ buffer for price protection
  const limitPriceUp = opportunity.askUp + 0.02;
  const limitPriceDown = opportunity.askDown + 0.02;

  // Verify total cost is within maxTotalCost limit
  const maxCost = getMaxTotalCost();
  if (opportunity.totalCost > maxCost) {
    log.warn({
      totalCost: opportunity.totalCost.toFixed(3),
      maxCost: maxCost.toFixed(3),
    }, '❌ Trade rejected: total cost exceeds maxTotalCost');
    return { success: false, error: `Total cost ${opportunity.totalCost.toFixed(3)} > max ${maxCost}` };
  }

  try {
    // Execute both orders as FAK (Fill-And-Kill) with limit prices for protection
    // FAK fills as much as possible at or below limit price, cancels unfilled portion
    const [resultUp, resultDown] = await Promise.all([
      executeOrder(tokenIdUp, 'BUY', sizeUp, 'FAK', limitPriceUp, opportunity.market, 'UP'),
      executeOrder(tokenIdDown, 'BUY', sizeDown, 'FAK', limitPriceDown, opportunity.market, 'DOWN'),
    ]);

    const orderEnd = performance.now();
    const orderExecutionMs = orderEnd - orderStart;
    const detectionToStartMs = opportunity.detectedAt ? orderStart - opportunity.detectedAt : undefined;
    const totalLatencyMs = opportunity.detectedAt ? orderEnd - opportunity.detectedAt : orderExecutionMs;

    // Log latency metrics
    log.info(
      {
        detectionToStartMs: detectionToStartMs?.toFixed(1),
        orderExecutionMs: orderExecutionMs.toFixed(1),
        totalLatencyMs: totalLatencyMs.toFixed(1),
      },
      '⏱️ Trade latency metrics'
    );

    // Check if both orders succeeded (at least partially with FAK)
    if (!resultUp.success || !resultDown.success) {
      const error = resultUp.error ?? resultDown.error ?? 'Unknown error';
      log.warn({ resultUp, resultDown }, 'Trade partially or fully failed');

      // ROLLBACK: If one side succeeded and the other failed, sell the successful side
      if (resultUp.success && !resultDown.success && resultUp.filledSize) {
        await rollbackPosition(tokenIdUp, resultUp.filledSize, 'SELL', 'UP failed, rolling back DOWN');
      } else if (resultDown.success && !resultUp.success && resultDown.filledSize) {
        await rollbackPosition(tokenIdDown, resultDown.filledSize, 'SELL', 'DOWN failed, rolling back UP');
      }

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
        latencyMs: totalLatencyMs.toFixed(1),
      },
      '✅ Trade executed successfully'
    );

    return { success: true, position, latencyMs: totalLatencyMs };
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
  orderType: 'FOK' | 'FAK' | 'GTC',
  limitPrice?: number,
  market?: string,
  tokenSide?: 'UP' | 'DOWN'
): Promise<TradeResult> {
  const client = getClobClient();

  try {
    log.debug(
      { tokenId: tokenId.substring(0, 16) + '...', side, amount, orderType, limitPrice },
      'Executing CLOB order'
    );

    // Fee rate in basis points - 0 for hourly markets (free trading)
    const feeRateBps = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;

    // Check for pre-signed order first (saves ~200-400ms)
    if (market && tokenSide && limitPrice) {
      const presigned = getPresignedOrder(market, tokenSide, side, limitPrice, amount);
      if (presigned) {
        log.info({ market, tokenSide, limitPrice }, '⚡ Using pre-signed order');
        result = await postPresignedOrder(
          presigned,
          orderType === 'FOK' ? OrderType.FOK : orderType === 'FAK' ? OrderType.FAK : OrderType.GTC
        );
      }
    }

    // If no pre-signed order, create and post with limit price
    if (!result) {
      if (limitPrice) {
        // Use limit order with price protection
        result = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: limitPrice,
            size: amount,
            side: side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps,
          },
          { negRisk: false, tickSize: '0.01' },
          orderType === 'FOK' ? OrderType.FOK : orderType === 'FAK' ? OrderType.FAK : OrderType.GTC
        );
      } else {
        // Fallback to market order
        result = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            amount: amount,
            side: side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps,
          },
          { negRisk: false, tickSize: '0.01' },
          orderType === 'FOK' ? OrderType.FOK : orderType === 'FAK' ? OrderType.FAK : OrderType.GTC
        );
      }
    }

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

// Rollback a position by selling the filled side
async function rollbackPosition(
  tokenId: string,
  size: number,
  side: 'BUY' | 'SELL',
  reason: string
): Promise<void> {
  log.warn({ tokenId: tokenId.substring(0, 16) + '...', size, side, reason }, '🔄 Attempting rollback');

  try {
    const result = await executeOrder(tokenId, side, size, 'FAK');
    if (result.success) {
      log.info(
        { filledSize: result.filledSize, filledPrice: result.filledPrice },
        '✅ Rollback successful'
      );
    } else {
      log.error({ error: result.error }, '❌ Rollback failed - manual intervention may be needed');
    }
  } catch (error) {
    log.error({ error }, '❌ Rollback exception - manual intervention may be needed');
  }
}

// Check if we can execute (CLOB client is ready or paper mode)
export function isReady(): boolean {
  return isPaperMode() || clobClient !== null;
}
