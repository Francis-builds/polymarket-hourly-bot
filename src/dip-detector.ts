import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { saveOrderbookSnapshot } from './db.js';
import { getThreshold, getMaxPositionSize } from './runtime-config.js';
import type { Orderbook, DipOpportunity, OrderbookLevel, MarketWindow } from './types.js';

const log = createChildLogger('dip-detector');

// Track last trade time per market for cooldown
const lastTradeTime: Map<string, number> = new Map();

// Track pending trades to prevent race conditions
const pendingTrades: Set<string> = new Set();

// Track account balance for progressive sizing
let currentBalance = config.trading.initialBalance;

// Minimum trade size in USDC
const MIN_TRADE_USDC = 20;
// Maximum trade size in USDC
const MAX_TRADE_USDC = 100;

/**
 * Calculate the REAL fee rate for 15m markets based on price
 * Formula: fee = 2 * (p * (1-p))^3
 * - At p=0.50: fee = 2 * 0.015625 = 0.03125 = ~3.12% (max)
 * - At p=0.90: fee = 2 * 0.000729 = 0.00146 = ~0.15%
 * - At p=0.10: fee = 2 * 0.000729 = 0.00146 = ~0.15%
 *
 * Source: Polymarket documentation confirms ~3.12% max fee at p=0.50
 * (100 shares at $0.50 = $50 trade, fee = $1.56 = 3.12%)
 *
 * For 1h+ markets: fee = 0 (free)
 */
export function calculateRealFeeRate(price: number, timeframe: string): number {
  // 1h and longer markets are FREE
  if (timeframe !== '15m') {
    return 0;
  }

  // 15m markets use the formula: 2 * (p * (1-p))^3
  const pq = price * (1 - price);
  const feeRate = 2 * pq * pq * pq;

  return feeRate;
}

/**
 * Calculate the average fill price for a given size using order book depth
 */
export function calculateFillPrice(
  asks: OrderbookLevel[],
  requestedShares: number
): { avgPrice: number; totalCost: number; filledShares: number; levels: number } {
  if (asks.length === 0 || requestedShares <= 0) {
    return { avgPrice: 0, totalCost: 0, filledShares: 0, levels: 0 };
  }

  let remainingShares = requestedShares;
  let totalCost = 0;
  let filledShares = 0;
  let levelsUsed = 0;

  for (const level of asks) {
    if (remainingShares <= 0) break;

    const sharesToBuy = Math.min(remainingShares, level.size);
    totalCost += sharesToBuy * level.price;
    filledShares += sharesToBuy;
    remainingShares -= sharesToBuy;
    levelsUsed++;
  }

  const avgPrice = filledShares > 0 ? totalCost / filledShares : 0;

  return {
    avgPrice,
    totalCost,
    filledShares,
    levels: levelsUsed,
  };
}

/**
 * Get total available liquidity across all levels
 */
export function getTotalLiquidity(asks: OrderbookLevel[]): number {
  return asks.reduce((sum, level) => sum + level.size, 0);
}

export function getCurrentBalance(): number {
  return currentBalance;
}

export function updateBalance(profit: number): void {
  currentBalance += profit;
  log.info({ balance: currentBalance.toFixed(2), change: profit.toFixed(2) }, '💰 Balance updated');
}

export function resetBalance(): void {
  currentBalance = config.trading.initialBalance;
}

export interface DetectionResult {
  shouldTrade: boolean;
  opportunity?: DipOpportunity;
  skipReason?: string;
}

/**
 * SIMPLIFIED DIP DETECTION
 *
 * Logic:
 * 1. Is there a dip? (cost < threshold) → YES = TRADE
 * 2. Minimum $20 USDC, maximum $100 USDC
 * 3. FOK order handles the rest (fills what it can, kills the rest)
 *
 * NO complex liquidity/slippage pre-checks - just try to trade!
 */
export function detectDip(orderbook: Orderbook): DetectionResult {
  const { market, timestamp, UP, DOWN } = orderbook;
  const { cooldownMs } = config.trading;
  const threshold = getThreshold();

  // Check if trade is already pending (prevents race condition / duplicate trades)
  if (pendingTrades.has(market)) {
    return {
      shouldTrade: false,
      skipReason: `Trade already pending`,
    };
  }

  // Check cooldown (30 seconds between trades per market)
  const lastTrade = lastTradeTime.get(market) ?? 0;
  if (timestamp - lastTrade < cooldownMs) {
    return {
      shouldTrade: false,
      skipReason: `Cooldown active`,
    };
  }

  // Check orderbook validity
  if (!UP.asks.length || !DOWN.asks.length) {
    return {
      shouldTrade: false,
      skipReason: 'Empty orderbook',
    };
  }

  const bestAskUp = UP.asks[0];
  const bestAskDown = DOWN.asks[0];

  if (!bestAskUp || !bestAskDown) {
    return {
      shouldTrade: false,
      skipReason: 'Invalid orderbook',
    };
  }

  // Minimum price check (5 cents per side to filter garbage)
  const MIN_PRICE = 0.05;
  if (bestAskUp.price < MIN_PRICE || bestAskDown.price < MIN_PRICE) {
    return {
      shouldTrade: false,
      skipReason: `Price too low`,
    };
  }

  // THE KEY CHECK: Is there a dip?
  const totalCost = bestAskUp.price + bestAskDown.price;

  if (totalCost >= threshold) {
    return {
      shouldTrade: false,
      skipReason: `No dip (${totalCost.toFixed(3)} >= ${threshold})`,
    };
  }

  // 🎯 DIP DETECTED! Calculate trade size and validate profitability

  // How many shares can we get for MAX_TRADE_USDC?
  const maxSharesUp = MAX_TRADE_USDC / bestAskUp.price;
  const maxSharesDown = MAX_TRADE_USDC / bestAskDown.price;
  const targetShares = Math.min(maxSharesUp, maxSharesDown);

  // Check available liquidity (just for info, we'll try anyway with FOK)
  const availableLiqUp = getTotalLiquidity(UP.asks);
  const availableLiqDown = getTotalLiquidity(DOWN.asks);
  const fillableShares = Math.min(targetShares, availableLiqUp, availableLiqDown);

  // Calculate trade value
  const tradeValue = fillableShares * totalCost;

  // Check minimum trade size
  if (tradeValue < MIN_TRADE_USDC) {
    log.warn({
      market,
      tradeValue: tradeValue.toFixed(2),
      minRequired: MIN_TRADE_USDC,
      liqUp: availableLiqUp.toFixed(0),
      liqDown: availableLiqDown.toFixed(0),
    }, '❌ Trade too small');
    return {
      shouldTrade: false,
      skipReason: `Trade too small ($${tradeValue.toFixed(0)} < $${MIN_TRADE_USDC})`,
    };
  }

  // Calculate expected profit using REAL fee rate based on prices
  // Fee is calculated separately for UP and DOWN based on their prices
  const feeRateUp = calculateRealFeeRate(bestAskUp.price, config.marketTimeframe);
  const feeRateDown = calculateRealFeeRate(bestAskDown.price, config.marketTimeframe);
  const costUp = fillableShares * bestAskUp.price;
  const costDown = fillableShares * bestAskDown.price;
  const estimatedFees = (costUp * feeRateUp) + (costDown * feeRateDown);

  const grossProfit = (1.0 - totalCost) * fillableShares;
  const expectedProfit = grossProfit - estimatedFees;
  const profitPercent = (expectedProfit / tradeValue) * 100;
  const effectiveFeeRate = estimatedFees / tradeValue;

  // 🛑 CRITICAL: NEVER execute trades with negative or insufficient profit
  const MIN_PROFIT_PCT = 1.0; // Require at least 1% profit after fees
  if (profitPercent < MIN_PROFIT_PCT) {
    log.warn({
      market,
      cost: totalCost.toFixed(3),
      grossProfit: grossProfit.toFixed(2),
      fees: estimatedFees.toFixed(2),
      expectedProfit: expectedProfit.toFixed(2),
      profitPct: profitPercent.toFixed(1) + '%',
      feeRateUp: (feeRateUp * 100).toFixed(2) + '%',
      feeRateDown: (feeRateDown * 100).toFixed(2) + '%',
      effectiveFee: (effectiveFeeRate * 100).toFixed(2) + '%',
      minRequired: MIN_PROFIT_PCT + '%',
    }, '❌ REJECTED: Profit too low after fees (would lose money!)');
    return {
      shouldTrade: false,
      skipReason: `Profit ${profitPercent.toFixed(1)}% < ${MIN_PROFIT_PCT}% min (fees: ${(effectiveFeeRate * 100).toFixed(1)}%)`,
    };
  }

  // Build market window info if available
  let marketWindow: MarketWindow | undefined;
  if (orderbook.windowOffset !== undefined && orderbook.windowLabel) {
    // Calculate window times based on 15-minute periods
    const periodSeconds = 15 * 60; // TODO: make configurable
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentPeriodStart = Math.floor(nowSeconds / periodSeconds) * periodSeconds;
    const windowStartSeconds = currentPeriodStart + (orderbook.windowOffset * periodSeconds);

    marketWindow = {
      offset: orderbook.windowOffset,
      label: orderbook.windowLabel,
      startTime: new Date(windowStartSeconds * 1000),
      endTime: new Date((windowStartSeconds + periodSeconds) * 1000),
    };
  }

  // Build opportunity
  const opportunity: DipOpportunity = {
    market,
    timestamp,
    marketWindow,
    askUp: bestAskUp.price,
    askDown: bestAskDown.price,
    avgFillPriceUp: bestAskUp.price,
    avgFillPriceDown: bestAskDown.price,
    totalCost,
    bestCaseCost: totalCost,
    expectedProfit,
    profitPercent,
    slippageUp: 0,
    slippageDown: 0,
    totalSlippage: 0,
    liquidityUp: availableLiqUp,
    liquidityDown: availableLiqDown,
    levelsUsedUp: 1,
    levelsUsedDown: 1,
    detectedAt: performance.now(),
  };

  // LOG IT AND GO!
  const windowStr = marketWindow ? ` [${marketWindow.label}]` : '';
  log.info(
    {
      market,
      window: marketWindow?.label ?? 'now',
      cost: totalCost.toFixed(3),
      threshold,
      discount: ((1 - totalCost) * 100).toFixed(1) + '%',
      shares: fillableShares.toFixed(0),
      tradeUSDC: tradeValue.toFixed(0),
      fees: estimatedFees.toFixed(2),
      feeRate: (effectiveFeeRate * 100).toFixed(2) + '%',
      expectedProfit: expectedProfit.toFixed(2),
      profitPct: profitPercent.toFixed(1) + '%',
      liqUp: availableLiqUp.toFixed(0),
      liqDown: availableLiqDown.toFixed(0),
    },
    `🎯 DIP DETECTED${windowStr} - EXECUTING TRADE!`
  );

  // Save snapshot for analysis
  try {
    saveOrderbookSnapshot({
      timestamp,
      market,
      bestAskUp: bestAskUp.price,
      bestAskDown: bestAskDown.price,
      totalCost,
      liquidityUp5pct: availableLiqUp,
      liquidityDown5pct: availableLiqDown,
      depthUp: UP.asks.slice(0, 5),
      depthDown: DOWN.asks.slice(0, 5),
    });
  } catch (err) {
    log.warn({ err, market }, 'Failed to save snapshot');
  }

  return {
    shouldTrade: true,
    opportunity,
  };
}

// Mark trade as pending BEFORE execution (prevents race condition)
export function markTradePending(market: string): void {
  pendingTrades.add(market);
  log.debug({ market }, '🔒 Trade marked as pending');
}

// Mark trade as executed AFTER completion (clears pending, sets cooldown)
export function markTradeExecuted(market: string): void {
  pendingTrades.delete(market);
  lastTradeTime.set(market, Date.now());
  log.debug({ market }, '✅ Trade executed, cooldown started');
}

// Clear pending state if trade fails
export function clearTradePending(market: string): void {
  pendingTrades.delete(market);
  log.debug({ market }, '🔓 Trade pending cleared (failed or cancelled)');
}

export function getCooldownRemaining(market: string): number {
  const lastTrade = lastTradeTime.get(market) ?? 0;
  const elapsed = Date.now() - lastTrade;
  return Math.max(0, config.trading.cooldownMs - elapsed);
}

// Simple position size calculation
// IMPORTANT: maxPositionSize is the TOTAL cost (UP + DOWN combined), not per-side
export function calculatePositionSize(opportunity: DipOpportunity): {
  sizeUp: number;
  sizeDown: number;
  totalCost: number;
} {
  const maxPositionSize = getMaxPositionSize();

  // Total budget is the smaller of MAX_TRADE_USDC or maxPositionSize
  const totalBudget = Math.min(MAX_TRADE_USDC, maxPositionSize);

  // Calculate shares based on TOTAL cost (UP + DOWN)
  // shares = totalBudget / (priceUp + priceDown)
  const totalCostPerShare = opportunity.askUp + opportunity.askDown;
  const maxSharesByBudget = totalBudget / totalCostPerShare;

  // Limit by available liquidity on each side
  const shares = Math.min(maxSharesByBudget, opportunity.liquidityUp, opportunity.liquidityDown);

  const actualTotalCost = shares * totalCostPerShare;

  log.debug({
    totalBudget: totalBudget.toFixed(2),
    priceUp: opportunity.askUp.toFixed(3),
    priceDown: opportunity.askDown.toFixed(3),
    totalCostPerShare: totalCostPerShare.toFixed(3),
    shares: shares.toFixed(2),
    actualTotalCost: actualTotalCost.toFixed(2),
  }, '📐 Position sizing');

  return {
    sizeUp: shares,
    sizeDown: shares,
    totalCost: actualTotalCost,
  };
}

// Extended sizing result (simplified)
export interface ExtendedSizingResult {
  sizeUp: number;
  sizeDown: number;
  totalCost: number;
  liquidityAnalysis: { up: { availableSize: number }; down: { availableSize: number }; combinedSlippage: number; adjustedProfit: number };
  estimatedSlippage: number;
  adjustedProfit: number;
  viable: boolean;
  reason?: string;
}

// Simplified position sizing - just return viable=true, let FOK handle it
export function calculatePositionSizeWithLiquidity(
  opportunity: DipOpportunity,
  orderbook: Orderbook
): ExtendedSizingResult {
  const { sizeUp, sizeDown, totalCost } = calculatePositionSize(opportunity);

  // Always viable - FOK will handle liquidity issues
  return {
    sizeUp,
    sizeDown,
    totalCost,
    liquidityAnalysis: {
      up: { availableSize: opportunity.liquidityUp },
      down: { availableSize: opportunity.liquidityDown },
      combinedSlippage: 0,
      adjustedProfit: opportunity.expectedProfit,
    },
    estimatedSlippage: 0,
    adjustedProfit: opportunity.expectedProfit,
    viable: true,
  };
}

// Backwards compatibility
export function validateLiquidity(
  opportunity: DipOpportunity,
  requiredSize: number
): { valid: boolean; reason?: string } {
  return { valid: true }; // Let FOK handle it
}

export function getActiveDips(): Array<{
  market: string;
  durationSec: number;
  startCost: number;
  minCost: number;
  maxLiquidityUp: number;
  maxLiquidityDown: number;
  updates: number;
}> {
  return []; // Simplified - no tracking
}
