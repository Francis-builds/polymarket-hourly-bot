import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { savePosition, getOpenPositions, getPositionById } from './db.js';
import { getMaxOpenPositions } from './runtime-config.js';
import type { Position, DipOpportunity } from './types.js';

const log = createChildLogger('position-manager');

// In-memory cache of open positions
let openPositions: Map<string, Position> = new Map();

export function initPositionManager(): void {
  // Load open positions from DB
  const positions = getOpenPositions();
  openPositions = new Map(positions.map((p) => [p.id, p]));
  log.info({ count: openPositions.size }, 'Loaded open positions from DB');
}

export function canOpenPosition(): boolean {
  return openPositions.size < getMaxOpenPositions();
}

export function getOpenPositionCount(): number {
  return openPositions.size;
}

export function hasOpenPositionForMarket(market: string): boolean {
  for (const position of openPositions.values()) {
    if (position.market === market) {
      return true;
    }
  }
  return false;
}

export interface CreatePositionOptions {
  estimatedSlippage?: number;
  executionLatency?: number;
  totalLatency?: number;
}

export function createPosition(
  opportunity: DipOpportunity,
  tradeResult: Partial<Position>,
  options?: CreatePositionOptions
): Position {
  const position: Position = {
    id: tradeResult.id ?? generateId(),
    market: opportunity.market,
    openedAt: tradeResult.openedAt ?? Date.now(),
    status: 'open',
    costUp: tradeResult.costUp ?? opportunity.askUp,
    costDown: tradeResult.costDown ?? opportunity.askDown,
    sizeUp: tradeResult.sizeUp ?? 0,
    sizeDown: tradeResult.sizeDown ?? 0,
    totalCost: tradeResult.totalCost ?? 0,
    expectedProfit: tradeResult.expectedProfit ?? opportunity.expectedProfit,
    // Liquidity data for analysis
    askUp: opportunity.askUp,
    askDown: opportunity.askDown,
    liquidityUp: opportunity.liquidityUp,
    liquidityDown: opportunity.liquidityDown,
    estimatedSlippage: options?.estimatedSlippage,
    // Latency tracking
    executionLatency: tradeResult.executionLatency ?? options?.executionLatency,
    totalLatency: tradeResult.totalLatency ?? options?.totalLatency,
    fees: tradeResult.fees,
  };

  // Save to DB and cache
  savePosition(position);
  openPositions.set(position.id, position);

  log.info({
    positionId: position.id,
    market: position.market,
    askUp: position.askUp.toFixed(4),
    askDown: position.askDown.toFixed(4),
    liquidityUp: position.liquidityUp.toFixed(2),
    liquidityDown: position.liquidityDown.toFixed(2),
    estimatedSlippage: options?.estimatedSlippage ? (options.estimatedSlippage * 100).toFixed(2) + '%' : 'N/A',
    latencyMs: position.totalLatency ?? 'N/A',
  }, 'Position created with liquidity data');

  return position;
}

export function resolvePosition(
  positionId: string,
  outcome: 'UP' | 'DOWN',
  payout: number,
  fees: number
): Position | null {
  const position = openPositions.get(positionId);

  if (!position) {
    log.warn({ positionId }, 'Position not found for resolution');
    return null;
  }

  const actualProfit = payout - position.totalCost - fees;

  const resolved: Position = {
    ...position,
    status: 'resolved',
    resolvedAt: Date.now(),
    outcome,
    payout,
    fees,
    actualProfit,
  };

  // Update DB and remove from cache
  savePosition(resolved);
  openPositions.delete(positionId);

  log.info(
    {
      positionId,
      outcome,
      payout: payout.toFixed(2),
      actualProfit: actualProfit.toFixed(2),
    },
    'Position resolved'
  );

  return resolved;
}

export function markPositionFailed(positionId: string, error: string): void {
  const position = openPositions.get(positionId);

  if (!position) {
    log.warn({ positionId }, 'Position not found for marking as failed');
    return;
  }

  const failed: Position = {
    ...position,
    status: 'failed',
    resolvedAt: Date.now(),
    actualProfit: -position.totalCost, // Lost the entire position
  };

  savePosition(failed);
  openPositions.delete(positionId);

  log.error({ positionId, error }, 'Position marked as failed');
}

export function getPosition(positionId: string): Position | null {
  return openPositions.get(positionId) ?? getPositionById(positionId);
}

export function getAllOpenPositions(): Position[] {
  return Array.from(openPositions.values());
}

// Check positions that should have resolved (15-min market)
export function getExpiredPositions(maxAgeMs: number = 20 * 60 * 1000): Position[] {
  const now = Date.now();
  const expired: Position[] = [];

  for (const position of openPositions.values()) {
    if (now - position.openedAt > maxAgeMs) {
      expired.push(position);
    }
  }

  return expired;
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pos_${timestamp}_${random}`;
}

// Summary for logging/notifications
export function getPositionsSummary(): {
  open: number;
  totalInvested: number;
  expectedProfit: number;
} {
  let totalInvested = 0;
  let expectedProfit = 0;

  for (const position of openPositions.values()) {
    totalInvested += position.totalCost;
    expectedProfit += position.expectedProfit;
  }

  return {
    open: openPositions.size,
    totalInvested,
    expectedProfit,
  };
}
