import { config } from './config.js';
import { createChildLogger } from './logger.js';
import type { OrderbookLevel, LiquidityAnalysis } from './types.js';

const log = createChildLogger('liquidity');

export interface AggregatedLiquidity {
  up: LiquidityAnalysis;
  down: LiquidityAnalysis;
  combinedSlippage: number;
  adjustedTotalCost: number;
  adjustedProfit: number;
  profitable: boolean;
}

/**
 * Analyze liquidity depth for a single side of the orderbook
 * Calculates VWAP and slippage for a target size across multiple levels
 */
export function analyzeSideLiquidity(
  asks: OrderbookLevel[],
  targetSize: number,
  side: 'UP' | 'DOWN'
): LiquidityAnalysis {
  if (!asks.length) {
    return {
      side,
      availableSize: 0,
      vwap: 0,
      slippage: 1, // 100% slippage = can't fill
      levels: 0,
      fillable: false,
    };
  }

  const bestAsk = asks[0].price;
  let remainingSize = targetSize;
  let totalCost = 0;
  let levelsUsed = 0;
  let totalFilled = 0;

  for (const level of asks) {
    if (remainingSize <= 0) break;

    const fillSize = Math.min(remainingSize, level.size);
    totalCost += fillSize * level.price;
    totalFilled += fillSize;
    remainingSize -= fillSize;
    levelsUsed++;
  }

  const vwap = totalFilled > 0 ? totalCost / totalFilled : 0;
  const slippage = bestAsk > 0 ? (vwap - bestAsk) / bestAsk : 0;
  const fillable = remainingSize <= 0;

  return {
    side,
    availableSize: totalFilled,
    vwap,
    slippage,
    levels: levelsUsed,
    fillable,
  };
}

/**
 * Analyze combined liquidity for both sides of an arbitrage trade
 * This is the main function to determine if a trade is viable
 */
export function analyzeArbitrageLiquidity(
  asksUp: OrderbookLevel[],
  asksDown: OrderbookLevel[],
  targetSize: number
): AggregatedLiquidity {
  const up = analyzeSideLiquidity(asksUp, targetSize, 'UP');
  const down = analyzeSideLiquidity(asksDown, targetSize, 'DOWN');

  // Combined slippage is the weighted impact on total cost
  const bestAskUp = asksUp[0]?.price ?? 0;
  const bestAskDown = asksDown[0]?.price ?? 0;
  const idealCost = bestAskUp + bestAskDown;
  const actualCost = up.vwap + down.vwap;
  const combinedSlippage = idealCost > 0 ? (actualCost - idealCost) / idealCost : 0;

  // Adjusted profit after slippage
  const adjustedTotalCost = actualCost;
  const adjustedProfit = 1.0 - adjustedTotalCost;

  // Is this still profitable after fees (~3%)?
  const profitable = adjustedProfit > config.trading.minProfit;

  return {
    up,
    down,
    combinedSlippage,
    adjustedTotalCost,
    adjustedProfit,
    profitable,
  };
}

/**
 * Find the maximum size we can trade while keeping slippage under the limit
 * Uses binary search for efficiency
 */
export function findOptimalSize(
  asksUp: OrderbookLevel[],
  asksDown: OrderbookLevel[],
  maxSize: number,
  maxSlippage: number
): { optimalSize: number; analysis: AggregatedLiquidity } {
  let low = 0;
  let high = maxSize;
  let bestSize = 0;
  let bestAnalysis: AggregatedLiquidity | null = null;

  // Minimum trade size (avoid dust)
  const minSize = 1;

  // Binary search for optimal size
  while (high - low > minSize) {
    const mid = (low + high) / 2;
    const analysis = analyzeArbitrageLiquidity(asksUp, asksDown, mid);

    if (analysis.combinedSlippage <= maxSlippage && analysis.profitable && analysis.up.fillable && analysis.down.fillable) {
      bestSize = mid;
      bestAnalysis = analysis;
      low = mid;
    } else {
      high = mid;
    }
  }

  // If no valid size found, try minimum size
  if (!bestAnalysis) {
    bestAnalysis = analyzeArbitrageLiquidity(asksUp, asksDown, minSize);
    if (bestAnalysis.combinedSlippage <= maxSlippage && bestAnalysis.profitable) {
      bestSize = minSize;
    }
  }

  log.debug({
    maxSize: maxSize.toFixed(2),
    optimalSize: bestSize.toFixed(2),
    slippage: bestAnalysis ? (bestAnalysis.combinedSlippage * 100).toFixed(2) + '%' : 'N/A',
    profitable: bestAnalysis?.profitable ?? false,
  }, 'Optimal size calculation');

  return {
    optimalSize: bestSize,
    analysis: bestAnalysis ?? analyzeArbitrageLiquidity(asksUp, asksDown, 0),
  };
}

/**
 * Get total available liquidity across all levels
 */
export function getTotalLiquidity(asks: OrderbookLevel[]): number {
  return asks.reduce((sum, level) => sum + level.size, 0);
}

/**
 * Log detailed liquidity analysis for debugging
 */
export function logLiquidityAnalysis(
  market: string,
  analysis: AggregatedLiquidity,
  targetSize: number
): void {
  log.info({
    market,
    targetSize: targetSize.toFixed(2),
    upLiquidity: {
      available: analysis.up.availableSize.toFixed(2),
      vwap: analysis.up.vwap.toFixed(4),
      slippage: (analysis.up.slippage * 100).toFixed(2) + '%',
      levels: analysis.up.levels,
      fillable: analysis.up.fillable,
    },
    downLiquidity: {
      available: analysis.down.availableSize.toFixed(2),
      vwap: analysis.down.vwap.toFixed(4),
      slippage: (analysis.down.slippage * 100).toFixed(2) + '%',
      levels: analysis.down.levels,
      fillable: analysis.down.fillable,
    },
    combined: {
      slippage: (analysis.combinedSlippage * 100).toFixed(2) + '%',
      adjustedCost: analysis.adjustedTotalCost.toFixed(4),
      adjustedProfit: analysis.adjustedProfit.toFixed(4),
      profitable: analysis.profitable,
    },
  }, 'Liquidity analysis');
}
