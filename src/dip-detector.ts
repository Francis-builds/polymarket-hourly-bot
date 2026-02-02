import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { saveOrderbookSnapshot } from './db.js';
import {
  analyzeArbitrageLiquidity,
  type AggregatedLiquidity,
} from './liquidity-analyzer.js';
import { getThreshold, getMaxPositionSize } from './runtime-config.js';
import type { Orderbook, DipOpportunity, OrderbookLevel } from './types.js';

const log = createChildLogger('dip-detector');

// Track last trade time per market for cooldown
const lastTradeTime: Map<string, number> = new Map();

// Track account balance for progressive sizing
let currentBalance = config.trading.initialBalance;

// Track active dips for duration analysis
interface ActiveDip {
  market: string;
  startTime: number;
  startCost: number;
  minCost: number;
  maxLiquidityUp: number;
  maxLiquidityDown: number;
  updates: number;
}
const activeDips: Map<string, ActiveDip> = new Map();

// Target trade size for FOK analysis
const TARGET_TRADE_SIZE = 100; // $100 USD

/**
 * Calculate the average fill price for a given size using order book depth
 * Returns the volume-weighted average price (VWAP) for the requested size
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
 * Get total available liquidity across all levels up to a price limit
 */
export function getTotalLiquidity(asks: OrderbookLevel[], maxPrice?: number): number {
  return asks
    .filter(level => maxPrice === undefined || level.price <= maxPrice)
    .reduce((sum, level) => sum + level.size, 0);
}

/**
 * Calculate slippage: difference between best price and actual fill price
 */
export function calculateSlippage(bestPrice: number, avgFillPrice: number): number {
  if (bestPrice === 0) return 0;
  return (avgFillPrice - bestPrice) / bestPrice;
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

export function detectDip(orderbook: Orderbook): DetectionResult {
  const { market, timestamp, UP, DOWN } = orderbook;
  const { minProfit, cooldownMs, maxSlippagePct, minProfitAfterSlippage, riskPerTrade } = config.trading;
  // Use runtime config for threshold and maxPositionSize (can be changed via Telegram)
  const threshold = getThreshold();
  const maxPositionSize = getMaxPositionSize();
  // Fee rate based on market timeframe (0% for 1h, 3% for 15m)
  const feeRate = config.feeRates[config.marketTimeframe] ?? config.trading.feeRate;

  // Check cooldown
  const lastTrade = lastTradeTime.get(market) ?? 0;
  if (timestamp - lastTrade < cooldownMs) {
    return {
      shouldTrade: false,
      skipReason: `Cooldown active (${Math.ceil((cooldownMs - (timestamp - lastTrade)) / 1000)}s remaining)`,
    };
  }

  // Check orderbook validity
  if (!UP.asks.length || !DOWN.asks.length) {
    return {
      shouldTrade: false,
      skipReason: 'Empty orderbook (no asks)',
    };
  }

  const bestAskUp = UP.asks[0];
  const bestAskDown = DOWN.asks[0];

  if (!bestAskUp || !bestAskDown) {
    return {
      shouldTrade: false,
      skipReason: 'Invalid orderbook data',
    };
  }

  // Minimum price check: reject if either side has unrealistic price
  // This prevents false positives when new markets have no real liquidity
  const MIN_REALISTIC_PRICE = 0.05; // 5 cents minimum per side
  if (bestAskUp.price < MIN_REALISTIC_PRICE || bestAskDown.price < MIN_REALISTIC_PRICE) {
    return {
      shouldTrade: false,
      skipReason: `Price too low (UP: $${bestAskUp.price.toFixed(3)}, DOWN: $${bestAskDown.price.toFixed(3)}) - likely no real liquidity`,
    };
  }

  // Best case cost (if we could fill at best ask)
  const bestCaseCost = bestAskUp.price + bestAskDown.price;

  // Calculate liquidity available for $100 FOK order
  const sharesFor100Up = TARGET_TRADE_SIZE / bestAskUp.price;
  const sharesFor100Down = TARGET_TRADE_SIZE / bestAskDown.price;
  const targetSharesFor100 = Math.min(sharesFor100Up, sharesFor100Down);
  const fillFor100Up = calculateFillPrice(UP.asks, targetSharesFor100);
  const fillFor100Down = calculateFillPrice(DOWN.asks, targetSharesFor100);
  const canFill100 = fillFor100Up.filledShares >= targetSharesFor100 * 0.95 &&
                     fillFor100Down.filledShares >= targetSharesFor100 * 0.95;

  // Quick check: if best case isn't profitable, skip
  if (bestCaseCost >= threshold) {
    // Check if a dip just ended
    const activeDip = activeDips.get(market);
    if (activeDip) {
      const durationMs = timestamp - activeDip.startTime;
      const durationSec = durationMs / 1000;

      log.info({
        market,
        durationSec: durationSec.toFixed(1),
        startCost: activeDip.startCost.toFixed(3),
        minCost: activeDip.minCost.toFixed(3),
        endCost: bestCaseCost.toFixed(3),
        maxLiqUp: activeDip.maxLiquidityUp.toFixed(0),
        maxLiqDown: activeDip.maxLiquidityDown.toFixed(0),
        updates: activeDip.updates,
      }, '⏱️ DIP ENDED - Duration tracking');

      activeDips.delete(market);
    }

    return {
      shouldTrade: false,
      skipReason: `No dip (best cost $${bestCaseCost.toFixed(3)} >= threshold $${threshold})`,
    };
  }

  // We have a dip! Track it
  const existingDip = activeDips.get(market);
  if (!existingDip) {
    // New dip starting
    activeDips.set(market, {
      market,
      startTime: timestamp,
      startCost: bestCaseCost,
      minCost: bestCaseCost,
      maxLiquidityUp: fillFor100Up.filledShares,
      maxLiquidityDown: fillFor100Down.filledShares,
      updates: 1,
    });

    log.info({
      market,
      cost: bestCaseCost.toFixed(3),
      profitPct: ((1 - bestCaseCost) / bestCaseCost * 100).toFixed(1),
      liqUp: fillFor100Up.filledShares.toFixed(0),
      liqDown: fillFor100Down.filledShares.toFixed(0),
      canFill100: canFill100 ? 'YES' : 'NO',
    }, '🔔 DIP STARTED - $100 FOK analysis');
  } else {
    // Update existing dip
    existingDip.minCost = Math.min(existingDip.minCost, bestCaseCost);
    existingDip.maxLiquidityUp = Math.max(existingDip.maxLiquidityUp, fillFor100Up.filledShares);
    existingDip.maxLiquidityDown = Math.max(existingDip.maxLiquidityDown, fillFor100Down.filledShares);
    existingDip.updates++;
  }

  // Calculate how many shares we want to buy based on position sizing
  const positionSize = Math.min(currentBalance * riskPerTrade, maxPositionSize);
  // Estimate shares based on best ask prices
  const estimatedSharesUp = positionSize / bestAskUp.price;
  const estimatedSharesDown = positionSize / bestAskDown.price;
  const targetShares = Math.min(estimatedSharesUp, estimatedSharesDown);

  // Calculate actual fill prices using order book depth
  const fillUp = calculateFillPrice(UP.asks, targetShares);
  const fillDown = calculateFillPrice(DOWN.asks, targetShares);

  // Check if we can fill the full order
  if (fillUp.filledShares < targetShares * 0.9 || fillDown.filledShares < targetShares * 0.9) {
    return {
      shouldTrade: false,
      skipReason: `Insufficient liquidity (UP: ${fillUp.filledShares.toFixed(0)}/${targetShares.toFixed(0)}, DOWN: ${fillDown.filledShares.toFixed(0)}/${targetShares.toFixed(0)})`,
    };
  }

  // Use the minimum filled shares (we need equal amounts)
  const actualShares = Math.min(fillUp.filledShares, fillDown.filledShares);

  // Recalculate with actual shares to get precise fill prices
  const finalFillUp = calculateFillPrice(UP.asks, actualShares);
  const finalFillDown = calculateFillPrice(DOWN.asks, actualShares);

  // Calculate slippage
  const slippageUp = calculateSlippage(bestAskUp.price, finalFillUp.avgPrice);
  const slippageDown = calculateSlippage(bestAskDown.price, finalFillDown.avgPrice);
  const totalSlippage = (slippageUp + slippageDown) / 2;

  // Check max slippage
  if (totalSlippage > maxSlippagePct) {
    return {
      shouldTrade: false,
      skipReason: `Slippage too high (${(totalSlippage * 100).toFixed(2)}% > ${(maxSlippagePct * 100).toFixed(2)}%)`,
    };
  }

  // Calculate actual cost and profit using fill prices (including fees)
  const actualTotalCost = finalFillUp.avgPrice + finalFillDown.avgPrice;
  const estimatedFees = actualTotalCost * feeRate;
  const expectedProfit = 1.0 - actualTotalCost - estimatedFees;
  const profitPercent = (expectedProfit / actualTotalCost) * 100;

  // Check if still profitable after slippage and fees
  if (profitPercent < minProfitAfterSlippage * 100) {
    return {
      shouldTrade: false,
      skipReason: `Profit after slippage+fees too low (${profitPercent.toFixed(2)}% < ${(minProfitAfterSlippage * 100).toFixed(2)}%)`,
    };
  }

  // Check minimum profit (after fees)
  if (expectedProfit < minProfit) {
    return {
      shouldTrade: false,
      skipReason: `Profit after fees too small ($${expectedProfit.toFixed(3)} < min $${minProfit})`,
    };
  }

  // Found a valid dip with acceptable slippage!
  const opportunity: DipOpportunity = {
    market,
    timestamp,
    askUp: bestAskUp.price,
    askDown: bestAskDown.price,
    avgFillPriceUp: finalFillUp.avgPrice,
    avgFillPriceDown: finalFillDown.avgPrice,
    totalCost: actualTotalCost,
    bestCaseCost,
    expectedProfit,
    profitPercent,
    slippageUp,
    slippageDown,
    totalSlippage,
    liquidityUp: getTotalLiquidity(UP.asks),
    liquidityDown: getTotalLiquidity(DOWN.asks),
    levelsUsedUp: finalFillUp.levels,
    levelsUsedDown: finalFillDown.levels,
    detectedAt: performance.now(), // High-res timestamp for latency tracking
  };

  log.info(
    {
      market,
      bestCost: bestCaseCost.toFixed(3),
      actualCost: actualTotalCost.toFixed(3),
      fees: estimatedFees.toFixed(3),
      slippage: `${(totalSlippage * 100).toFixed(2)}%`,
      netProfit: expectedProfit.toFixed(3),
      profitPct: profitPercent.toFixed(1),
      levelsUp: finalFillUp.levels,
      levelsDown: finalFillDown.levels,
    },
    '🎯 DIP DETECTED (slippage + fees accounted)!'
  );

  // Save orderbook snapshot for slippage analysis
  try {
    // Calculate liquidity within 5% of best ask
    const liquidityUp5pct = UP.asks
      .filter(l => l.price <= bestAskUp.price * 1.05)
      .reduce((sum, l) => sum + l.size, 0);
    const liquidityDown5pct = DOWN.asks
      .filter(l => l.price <= bestAskDown.price * 1.05)
      .reduce((sum, l) => sum + l.size, 0);

    saveOrderbookSnapshot({
      timestamp,
      market,
      bestAskUp: bestAskUp.price,
      bestAskDown: bestAskDown.price,
      totalCost: bestCaseCost,
      liquidityUp5pct,
      liquidityDown5pct,
      depthUp: UP.asks.slice(0, 10), // Save top 10 levels
      depthDown: DOWN.asks.slice(0, 10),
    });
    log.debug({ market, levels: UP.asks.length }, 'Orderbook snapshot saved');
  } catch (err) {
    log.warn({ err, market }, 'Failed to save orderbook snapshot');
  }

  return {
    shouldTrade: true,
    opportunity,
  };
}

export function markTradeExecuted(market: string): void {
  lastTradeTime.set(market, Date.now());
}

export function getCooldownRemaining(market: string): number {
  const lastTrade = lastTradeTime.get(market) ?? 0;
  const elapsed = Date.now() - lastTrade;
  return Math.max(0, config.trading.cooldownMs - elapsed);
}

// Simple position size calculation (for backwards compatibility)
export function calculatePositionSize(opportunity: DipOpportunity): {
  sizeUp: number;
  sizeDown: number;
  totalCost: number;
} {
  const { riskPerTrade } = config.trading;
  const maxPositionSize = getMaxPositionSize();

  // Progressive sizing: risk% of current balance, capped by maxPositionSize
  const riskBasedSize = currentBalance * riskPerTrade;
  const positionSize = Math.min(riskBasedSize, maxPositionSize);

  log.debug({
    balance: currentBalance.toFixed(2),
    riskPct: (riskPerTrade * 100).toFixed(0),
    riskBasedSize: riskBasedSize.toFixed(2),
    maxSize: maxPositionSize,
    actualSize: positionSize.toFixed(2),
  }, 'Position sizing');

  // Calculate max shares we can buy with positionSize
  const maxSharesUp = positionSize / opportunity.askUp;
  const maxSharesDown = positionSize / opportunity.askDown;

  // Limit by available liquidity
  const sharesUp = Math.min(maxSharesUp, opportunity.liquidityUp);
  const sharesDown = Math.min(maxSharesDown, opportunity.liquidityDown);

  // We need same NUMBER of shares on each side (one side pays $1/share)
  const shares = Math.min(sharesUp, sharesDown);

  const costUp = shares * opportunity.askUp;
  const costDown = shares * opportunity.askDown;

  return {
    sizeUp: shares,
    sizeDown: shares,
    totalCost: costUp + costDown,
  };
}

// Extended position sizing result with liquidity analysis
export interface ExtendedSizingResult {
  sizeUp: number;
  sizeDown: number;
  totalCost: number;
  liquidityAnalysis: AggregatedLiquidity;
  estimatedSlippage: number;
  adjustedProfit: number;
  viable: boolean;
  reason?: string;
}

// Simple FAK (Fill and Kill) position sizing: 50-200 USDC range
// FAK fills as much as possible at best prices, cancels unfilled portion
const MIN_TRADE_USDC = 50;
const MAX_TRADE_USDC = 200;

// Calculate position size with FAK logic (fill what's available, 50-200 USDC)
export function calculatePositionSizeWithLiquidity(
  opportunity: DipOpportunity,
  orderbook: Orderbook
): ExtendedSizingResult {
  // Calculate how many shares we can get for MAX_TRADE_USDC
  const maxSharesUp = MAX_TRADE_USDC / opportunity.askUp;
  const maxSharesDown = MAX_TRADE_USDC / opportunity.askDown;
  const maxShares = Math.min(maxSharesUp, maxSharesDown);

  // Analyze what we can actually fill
  const analysis = analyzeArbitrageLiquidity(
    orderbook.UP.asks,
    orderbook.DOWN.asks,
    maxShares
  );

  // How many shares can we actually fill on both sides?
  const fillableShares = Math.min(analysis.up.availableSize, analysis.down.availableSize);

  // Convert back to USDC value
  const fillableUSDC = fillableShares * (opportunity.askUp + opportunity.askDown) / 2;

  // FOK logic: use what's available between MIN and MAX
  let tradeShares = fillableShares;
  let viable = true;
  let reason: string | undefined;

  if (fillableUSDC < MIN_TRADE_USDC) {
    viable = false;
    reason = `Insufficient liquidity ($${fillableUSDC.toFixed(0)} < $${MIN_TRADE_USDC} min)`;
    tradeShares = 0;
  } else if (fillableUSDC > MAX_TRADE_USDC) {
    // Cap at max, recalculate shares
    tradeShares = MAX_TRADE_USDC / ((opportunity.askUp + opportunity.askDown) / 2);
  }

  // Calculate actual cost
  const costUp = tradeShares * opportunity.avgFillPriceUp;
  const costDown = tradeShares * opportunity.avgFillPriceDown;
  const totalCost = costUp + costDown;

  log.info({
    market: opportunity.market,
    fillableUSDC: fillableUSDC.toFixed(0),
    tradeShares: tradeShares.toFixed(1),
    totalCost: totalCost.toFixed(2),
    viable,
  }, viable ? '✅ FAK viable' : '❌ FAK insufficient liquidity');

  return {
    sizeUp: tradeShares,
    sizeDown: tradeShares,
    totalCost,
    liquidityAnalysis: analysis,
    estimatedSlippage: analysis.combinedSlippage,
    adjustedProfit: analysis.adjustedProfit,
    viable,
    reason,
  };
}

// Validate that orderbook depth supports our trade size
export function validateLiquidity(
  opportunity: DipOpportunity,
  requiredSize: number
): { valid: boolean; reason?: string } {
  if (opportunity.liquidityUp < requiredSize) {
    return {
      valid: false,
      reason: `Insufficient UP liquidity (${opportunity.liquidityUp} < ${requiredSize})`,
    };
  }

  if (opportunity.liquidityDown < requiredSize) {
    return {
      valid: false,
      reason: `Insufficient DOWN liquidity (${opportunity.liquidityDown} < ${requiredSize})`,
    };
  }

  return { valid: true };
}

// Get active dips info for monitoring
export function getActiveDips(): Array<{
  market: string;
  durationSec: number;
  startCost: number;
  minCost: number;
  maxLiquidityUp: number;
  maxLiquidityDown: number;
  updates: number;
}> {
  const now = Date.now();
  return Array.from(activeDips.values()).map(dip => ({
    market: dip.market,
    durationSec: (now - dip.startTime) / 1000,
    startCost: dip.startCost,
    minCost: dip.minCost,
    maxLiquidityUp: dip.maxLiquidityUp,
    maxLiquidityDown: dip.maxLiquidityDown,
    updates: dip.updates,
  }));
}
