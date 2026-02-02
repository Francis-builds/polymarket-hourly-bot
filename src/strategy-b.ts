/**
 * Strategy B: Two-Leg Dump Detection Strategy
 *
 * Leg 1: Wait for violent dump (movePct drop in ~3s) in first windowMin minutes
 *        Buy the side that dumped
 *
 * Leg 2: Wait for leg1Price + oppositeAsk <= sumTarget
 *        Buy the opposite side to hedge
 *
 * If round changes before Leg 2, abandon cycle (count as loss)
 */

import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { logEvent, savePosition } from './db.js';
import { executeDipTrade } from './executor.js';
import { getMarketTokens } from './market-data.js';
import {
  notifyStrategyBLeg1,
  notifyStrategyBComplete,
  notifyStrategyBAbandoned,
} from './notifier.js';
import type { Orderbook, Position, DipOpportunity } from './types.js';

const log = createChildLogger('strategy-b');

// Strategy B parameters
const PARAMS = {
  shares: 50, // Position size per leg (USD worth)
  sumTarget: 0.95, // Hedge threshold: leg1Price + oppositeAsk <= this
  movePct: 0.15, // Dump threshold: 15% drop
  windowMin: 2, // Minutes from round start to allow Leg 1
  priceHistorySeconds: 5, // How many seconds of price history to check for dumps
};

// Price history for dump detection
interface PricePoint {
  timestamp: number;
  askUp: number;
  askDown: number;
}

const priceHistory: Map<string, PricePoint[]> = new Map();

// Active cycles per market
interface ActiveCycle {
  market: string;
  roundStart: number; // Timestamp when round started
  leg1Side: 'UP' | 'DOWN';
  leg1Price: number;
  leg1Shares: number;
  leg1PositionId: string;
  leg1Timestamp: number;
  leg2Complete: boolean;
}

const activeCycles: Map<string, ActiveCycle> = new Map();

// Track Strategy B stats separately
let strategyBStats = {
  leg1Triggered: 0,
  leg2Triggered: 0,
  cyclesComplete: 0,
  cyclesAbandoned: 0,
  totalProfit: 0,
};

export function getStrategyBStats() {
  return { ...strategyBStats };
}

// Get current 15-min round start timestamp
function getCurrentRoundStart(): number {
  const now = Date.now();
  const period = 15 * 60 * 1000;
  return Math.floor(now / period) * period;
}

// Check if we're within the allowed window for Leg 1
function isWithinLeg1Window(): boolean {
  const roundStart = getCurrentRoundStart();
  const elapsed = Date.now() - roundStart;
  return elapsed < PARAMS.windowMin * 60 * 1000;
}

// Record price point for dump detection
function recordPrice(market: string, askUp: number, askDown: number): void {
  const now = Date.now();
  let history = priceHistory.get(market);

  if (!history) {
    history = [];
    priceHistory.set(market, history);
  }

  history.push({ timestamp: now, askUp, askDown });

  // Keep only last N seconds of history
  const cutoff = now - PARAMS.priceHistorySeconds * 1000;
  priceHistory.set(market, history.filter(p => p.timestamp > cutoff));
}

// Detect if a dump occurred (price dropped by movePct in the history window)
function detectDump(market: string, currentAskUp: number, currentAskDown: number): { dumped: boolean; side?: 'UP' | 'DOWN'; dropPct?: number } {
  const history = priceHistory.get(market);

  if (!history || history.length < 2) {
    return { dumped: false };
  }

  // Get oldest price in history (roughly 3-5 seconds ago)
  const oldest = history[0];

  // Check UP side dump
  if (oldest.askUp > 0) {
    const upDrop = (oldest.askUp - currentAskUp) / oldest.askUp;
    if (upDrop >= PARAMS.movePct) {
      return { dumped: true, side: 'UP', dropPct: upDrop * 100 };
    }
  }

  // Check DOWN side dump
  if (oldest.askDown > 0) {
    const downDrop = (oldest.askDown - currentAskDown) / oldest.askDown;
    if (downDrop >= PARAMS.movePct) {
      return { dumped: true, side: 'DOWN', dropPct: downDrop * 100 };
    }
  }

  return { dumped: false };
}

// Check if Leg 2 conditions are met
function canExecuteLeg2(cycle: ActiveCycle, currentAskUp: number, currentAskDown: number): boolean {
  const oppositeAsk = cycle.leg1Side === 'UP' ? currentAskDown : currentAskUp;
  const sum = cycle.leg1Price + oppositeAsk;
  return sum <= PARAMS.sumTarget;
}

// Main handler for Strategy B
export async function handleStrategyB(orderbook: Orderbook): Promise<void> {
  const market = orderbook.market;

  // Get current prices
  const askUp = orderbook.UP.asks[0]?.price ?? 0;
  const askDown = orderbook.DOWN.asks[0]?.price ?? 0;

  if (askUp === 0 || askDown === 0) return;

  // Record price for dump detection
  recordPrice(market, askUp, askDown);

  // Check for round change - abandon incomplete cycles
  const currentRound = getCurrentRoundStart();
  const cycle = activeCycles.get(market);

  if (cycle && cycle.roundStart !== currentRound) {
    // Round changed, abandon cycle
    const loss = cycle.leg1Price * cycle.leg1Shares;

    log.warn({
      market,
      leg1Side: cycle.leg1Side,
      leg1Price: cycle.leg1Price,
      loss,
    }, '🅱️ Strategy B: Round changed, abandoning cycle (Leg 1 loss)');

    strategyBStats.cyclesAbandoned++;
    activeCycles.delete(market);

    // Notify abandoned cycle
    await notifyStrategyBAbandoned(market, cycle.leg1Side, cycle.leg1Price, loss);

    logEvent('strategy_b_abandoned', {
      market,
      leg1Side: cycle.leg1Side,
      leg1Price: cycle.leg1Price,
      loss,
    });
  }

  // If we have an active cycle, check for Leg 2
  const activeCycle = activeCycles.get(market);
  if (activeCycle && !activeCycle.leg2Complete) {
    if (canExecuteLeg2(activeCycle, askUp, askDown)) {
      await executeLeg2(activeCycle, askUp, askDown);
    }
    return; // Don't start new Leg 1 while in a cycle
  }

  // Check for Leg 1 opportunity
  if (!activeCycle && isWithinLeg1Window()) {
    const dump = detectDump(market, askUp, askDown);

    if (dump.dumped && dump.side) {
      await executeLeg1(market, dump.side, dump.side === 'UP' ? askUp : askDown, dump.dropPct ?? 0);
    }
  }
}

async function executeLeg1(market: string, side: 'UP' | 'DOWN', price: number, dropPct: number): Promise<void> {
  log.info({
    market,
    side,
    price: price.toFixed(3),
    dropPct: dropPct.toFixed(1),
  }, '🅱️ Strategy B: LEG 1 - Dump detected, buying');

  const tokens = getMarketTokens(market);
  if (!tokens) {
    log.error({ market }, 'Market tokens not found for Strategy B');
    return;
  }

  const shares = Math.floor(PARAMS.shares / price);

  // Create opportunity for notification
  const opportunity: DipOpportunity = {
    market,
    timestamp: Date.now(),
    askUp: side === 'UP' ? price : 0,
    askDown: side === 'DOWN' ? price : 0,
    avgFillPriceUp: side === 'UP' ? price : 0,
    avgFillPriceDown: side === 'DOWN' ? price : 0,
    totalCost: price * shares,
    bestCaseCost: price * shares,
    expectedProfit: 0, // Unknown until Leg 2
    profitPercent: 0,
    slippageUp: 0,
    slippageDown: 0,
    totalSlippage: 0,
    liquidityUp: 1000,
    liquidityDown: 1000,
    levelsUsedUp: 1,
    levelsUsedDown: 1,
    detectedAt: performance.now(),
  };

  // In paper mode, simulate the trade
  if (config.paperTrading) {
    const positionId = `stb_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    // Create cycle
    activeCycles.set(market, {
      market,
      roundStart: getCurrentRoundStart(),
      leg1Side: side,
      leg1Price: price,
      leg1Shares: shares,
      leg1PositionId: positionId,
      leg1Timestamp: Date.now(),
      leg2Complete: false,
    });

    strategyBStats.leg1Triggered++;

    log.info({
      positionId,
      market,
      side,
      shares,
      cost: (price * shares).toFixed(2),
    }, '🅱️ PAPER Leg 1 executed');

    // Notify Leg 1
    await notifyStrategyBLeg1(market, side, price, shares, dropPct);

    logEvent('strategy_b_leg1', {
      positionId,
      market,
      side,
      price,
      shares,
      dropPct,
    });
  }
}

async function executeLeg2(cycle: ActiveCycle, askUp: number, askDown: number): Promise<void> {
  const oppositeSide = cycle.leg1Side === 'UP' ? 'DOWN' : 'UP';
  const oppositePrice = cycle.leg1Side === 'UP' ? askDown : askUp;
  const sum = cycle.leg1Price + oppositePrice;

  log.info({
    market: cycle.market,
    leg1Side: cycle.leg1Side,
    leg1Price: cycle.leg1Price.toFixed(3),
    leg2Side: oppositeSide,
    leg2Price: oppositePrice.toFixed(3),
    sum: sum.toFixed(3),
  }, '🅱️ Strategy B: LEG 2 - Hedge condition met, buying opposite');

  const shares = cycle.leg1Shares; // Same size as Leg 1

  if (config.paperTrading) {
    const leg2Cost = oppositePrice * shares;
    const totalCost = cycle.leg1Price * cycle.leg1Shares + leg2Cost;
    const payout = shares * 1.0; // One side will win
    const fees = totalCost * 0.03;
    const profit = payout - totalCost - fees;

    cycle.leg2Complete = true;
    strategyBStats.leg2Triggered++;
    strategyBStats.cyclesComplete++;
    strategyBStats.totalProfit += profit;

    // Save as resolved position
    const position: Position = {
      id: cycle.leg1PositionId,
      market: cycle.market,
      openedAt: cycle.leg1Timestamp,
      resolvedAt: Date.now(),
      status: 'resolved',
      costUp: cycle.leg1Side === 'UP' ? cycle.leg1Price : oppositePrice,
      costDown: cycle.leg1Side === 'DOWN' ? cycle.leg1Price : oppositePrice,
      sizeUp: shares,
      sizeDown: shares,
      totalCost,
      expectedProfit: profit,
      // Liquidity data (use leg1 prices as asks since strategy B is different)
      askUp: cycle.leg1Side === 'UP' ? cycle.leg1Price : oppositePrice,
      askDown: cycle.leg1Side === 'DOWN' ? cycle.leg1Price : oppositePrice,
      liquidityUp: shares, // Approximate - we filled this amount
      liquidityDown: shares,
      outcome: cycle.leg1Side, // Doesn't matter, we hedged
      payout,
      actualProfit: profit,
      fees,
    };

    // Mark as strategy B in the ID
    savePosition({ ...position, id: `STB_${position.id}` });

    log.info({
      positionId: cycle.leg1PositionId,
      totalCost: totalCost.toFixed(2),
      profit: profit.toFixed(2),
      roi: ((profit / totalCost) * 100).toFixed(1),
    }, '🅱️ PAPER Strategy B cycle complete');

    // Notify cycle complete
    await notifyStrategyBComplete(cycle.market, cycle.leg1Side, cycle.leg1Price, oppositePrice, totalCost, profit);

    logEvent('strategy_b_complete', {
      positionId: cycle.leg1PositionId,
      market: cycle.market,
      leg1Side: cycle.leg1Side,
      leg1Price: cycle.leg1Price,
      leg2Price: oppositePrice,
      totalCost,
      profit,
    });

    // Clean up cycle
    activeCycles.delete(cycle.market);
  }
}

// Get active cycles info for monitoring
export function getActiveCycles(): ActiveCycle[] {
  return Array.from(activeCycles.values());
}

// Reset stats (for testing)
export function resetStrategyBStats(): void {
  strategyBStats = {
    leg1Triggered: 0,
    leg2Triggered: 0,
    cyclesComplete: 0,
    cyclesAbandoned: 0,
    totalProfit: 0,
  };
}
