import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { isLiveTradingEnabled } from './notifier.js';
import type { DipOpportunity, Position, TradeResult } from './types.js';

const log = createChildLogger('executor');

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

// poly-sdk types (will be properly typed when we install the package)
interface PolymarketSDK {
  tradingService: {
    createMarketOrder(args: {
      tokenId: string;
      side: 'BUY' | 'SELL';
      amount: number;
      orderType: 'FOK' | 'GTC';
    }): Promise<{ orderId: string; filledSize: number; avgPrice: number }>;
    getOpenOrders(): Promise<unknown[]>;
    cancelOrder(orderId: string): Promise<void>;
  };
  marketService: {
    getOrderbook(tokenId: string): Promise<{
      bids: Array<{ price: number; size: number }>;
      asks: Array<{ price: number; size: number }>;
    }>;
    getMidpoint(tokenId: string): Promise<number>;
  };
  initialize(): Promise<void>;
  connect(): void;
  waitForConnection(): Promise<void>;
}

interface PolymarketSDKConstructor {
  create(options: { privateKey: string; chainId: number }): Promise<PolymarketSDK>;
}

let sdk: PolymarketSDK | null = null;

export async function initExecutor(): Promise<void> {
  // Skip SDK initialization in paper trading mode
  if (isPaperMode()) {
    log.info('📝 PAPER TRADING MODE - SDK initialization skipped');
    return;
  }

  try {
    // Dynamic import of Polymarket CLOB client
    // Note: Real trading requires @polymarket/clob-client to be properly configured
    const { ClobClient } = await import('@polymarket/clob-client');

    // For real trading, we'll need to set up the CLOB client properly
    // This is a placeholder - actual implementation would configure signatures, etc.
    log.info('Polymarket CLOB client loaded (real trading not yet implemented)');

    // TODO: Implement real trading with @polymarket/clob-client
    // sdk = new ClobClient(...)

  } catch (error) {
    log.error({ error }, 'Failed to initialize Polymarket SDK');
    throw error;
  }
}

export function getSDK(): PolymarketSDK {
  if (!sdk) {
    throw new Error('Executor not initialized. Call initExecutor() first.');
  }
  return sdk;
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

  // Real trading mode
  const sdk = getSDK();

  try {
    // Execute both orders as FOK (Fill-or-Kill) to avoid partial fills
    const [resultUp, resultDown] = await Promise.all([
      executeOrder(tokenIdUp, 'BUY', sizeUp, 'FOK'),
      executeOrder(tokenIdDown, 'BUY', sizeDown, 'FOK'),
    ]);

    // Check if both orders succeeded
    if (!resultUp.success || !resultDown.success) {
      const error = resultUp.error ?? resultDown.error ?? 'Unknown error';
      log.warn({ resultUp, resultDown }, 'Trade partially or fully failed');

      // TODO: If one succeeded and one failed, we may need to unwind
      // For FOK orders, this shouldn't happen - both should fill or neither

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
  orderType: 'FOK' | 'GTC'
): Promise<TradeResult> {
  const sdk = getSDK();

  try {
    const result = await sdk.tradingService.createMarketOrder({
      tokenId,
      side,
      amount,
      orderType,
    });

    return {
      success: true,
      orderId: result.orderId,
      filledSize: result.filledSize,
      filledPrice: result.avgPrice,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// Get current orderbook for a token
export async function getOrderbook(tokenId: string) {
  const sdk = getSDK();
  return sdk.marketService.getOrderbook(tokenId);
}

// Get midpoint price
export async function getMidpoint(tokenId: string): Promise<number> {
  const sdk = getSDK();
  return sdk.marketService.getMidpoint(tokenId);
}

function generatePositionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pos_${timestamp}_${random}`;
}

// Check if we can execute (SDK is ready or paper mode)
export function isReady(): boolean {
  return isPaperMode() || sdk !== null;
}
