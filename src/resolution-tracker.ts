import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { logEvent } from './db.js';
import {
  getAllOpenPositions,
  resolvePosition,
  getExpiredPositions,
} from './position-manager.js';
import { notifyPositionResolved } from './notifier.js';
import type { Position } from './types.js';

const log = createChildLogger('resolution-tracker');

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Market duration based on timeframe (hourly/4h/daily only - no 15m in this bot)
const TIMEFRAME_DURATION_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,      // 1 hour
  '4h': 4 * 60 * 60 * 1000,  // 4 hours
  'daily': 24 * 60 * 60 * 1000, // 24 hours
};

function getMarketDurationMs(): number {
  return TIMEFRAME_DURATION_MS[config.marketTimeframe] || 60 * 60 * 1000;
}
const RESOLUTION_DELAY_MS = 60 * 1000; // Check 1 minute after window closes

let nextCheckTimeout: NodeJS.Timeout | null = null;

// Cache of market resolution status
const marketResolutionCache: Map<string, { resolved: boolean; outcome?: 'UP' | 'DOWN'; checkedAt: number }> = new Map();

function getCurrentRoundStart(): number {
  const now = Date.now();
  const period = getMarketDurationMs();
  return Math.floor(now / period) * period;
}

function getNextWindowEnd(): number {
  return getCurrentRoundStart() + getMarketDurationMs();
}

function scheduleNextCheck(): void {
  const nextWindowEnd = getNextWindowEnd();
  const checkTime = nextWindowEnd + RESOLUTION_DELAY_MS;
  const delay = checkTime - Date.now();

  log.info({
    nextCheck: new Date(checkTime).toISOString(),
    delayMs: delay,
  }, 'Scheduled next resolution check');

  nextCheckTimeout = setTimeout(async () => {
    await checkResolutions();
    scheduleNextCheck(); // Schedule next window
  }, delay);
}

export function startResolutionTracker(): void {
  log.info({ timeframe: config.marketTimeframe }, `Starting resolution tracker (synced to ${config.marketTimeframe} windows)`);

  // Check immediately for any old positions
  checkResolutions();

  // Schedule checks synced to market window closes
  scheduleNextCheck();
}

export function stopResolutionTracker(): void {
  if (nextCheckTimeout) {
    clearTimeout(nextCheckTimeout);
    nextCheckTimeout = null;
  }
  log.info('Resolution tracker stopped');
}

async function checkResolutions(): Promise<void> {
  const openPositions = getAllOpenPositions();

  if (openPositions.length === 0) {
    log.debug('No open positions to resolve');
    return;
  }

  // Get the window that just closed (we check 1 min after window end)
  const now = Date.now();
  const currentWindowStart = getCurrentRoundStart();
  const previousWindowEnd = currentWindowStart; // The window that just ended

  // Resolve ALL positions opened in previous windows (before currentWindowStart)
  const positionsToResolve = openPositions.filter(p => {
    // Position's window = which market window it was opened in
    const positionWindow = Math.floor(p.openedAt / getMarketDurationMs()) * getMarketDurationMs();
    // If position was opened in a window that has now ended, resolve it
    return positionWindow < currentWindowStart;
  });

  if (positionsToResolve.length === 0) {
    log.debug({
      openCount: openPositions.length,
      currentWindow: new Date(currentWindowStart).toISOString(),
    }, 'No positions from previous windows to resolve');
    return;
  }

  log.info({
    count: positionsToResolve.length,
    windowEnded: new Date(previousWindowEnd).toISOString(),
  }, 'Resolving positions from closed window');

  for (const position of positionsToResolve) {
    try {
      await resolvePositionNow(position);
    } catch (error) {
      log.error({ error, positionId: position.id }, 'Error resolving position');
    }
  }
}

async function resolvePositionNow(position: Position): Promise<void> {
  // In paper trading mode, simulate resolution
  if (config.paperTrading) {
    // Random outcome (doesn't matter for arbitrage - we have both sides)
    const outcome: 'UP' | 'DOWN' = Math.random() > 0.5 ? 'UP' : 'DOWN';
    await resolvePositionWithOutcome(position, outcome);
    return;
  }

  // Real trading: Query Polymarket API for market resolution
  try {
    const resolution = await fetchMarketResolution(position.market);

    if (resolution.resolved && resolution.outcome) {
      await resolvePositionWithOutcome(position, resolution.outcome);
    } else {
      log.warn({ positionId: position.id, market: position.market }, 'Market not resolved yet, will retry');
    }
  } catch (error) {
    log.error({ error, market: position.market }, 'Failed to fetch market resolution');
  }
}

async function fetchMarketResolution(market: string): Promise<{ resolved: boolean; outcome?: 'UP' | 'DOWN' }> {
  // Extract the market slug from position market (e.g., "BTC" -> find the actual market)
  // Find the specific market instance for the configured timeframe

  // Try to get market info from Gamma API using human-readable slug
  const periodET = getCurrentPeriodET();
  const slug = generateMarketSlug(market, periodET);

  if (!slug) {
    log.warn({ market }, 'Could not generate slug for market');
    return { resolved: false };
  }

  const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const markets = await response.json();

  if (!Array.isArray(markets) || markets.length === 0) {
    return { resolved: false };
  }

  const marketData = markets[0];

  // Check if market has resolved
  if (marketData.closed || marketData.resolved) {
    // Determine outcome from winning token
    const outcomes = typeof marketData.outcomes === 'string'
      ? JSON.parse(marketData.outcomes)
      : marketData.outcomes;

    const outcomePrices = typeof marketData.outcomePrices === 'string'
      ? JSON.parse(marketData.outcomePrices)
      : marketData.outcomePrices;

    // If market resolved, one outcome should be ~1 and other ~0
    if (outcomePrices && outcomePrices.length >= 2) {
      const upPrice = parseFloat(outcomePrices[0]);
      const downPrice = parseFloat(outcomePrices[1]);

      if (upPrice > 0.9) {
        return { resolved: true, outcome: 'UP' };
      } else if (downPrice > 0.9) {
        return { resolved: true, outcome: 'DOWN' };
      }
    }

    // Fallback: check outcomes array for winner
    if (outcomes && outcomes.length >= 2) {
      // Usually the winning outcome is marked somehow
      return { resolved: true, outcome: 'UP' }; // Default, would need actual resolution data
    }
  }

  return { resolved: false };
}

async function resolvePositionWithOutcome(position: Position, outcome: 'UP' | 'DOWN'): Promise<void> {
  // Calculate payout: $1 per share (minimum of UP/DOWN sizes)
  const shares = Math.min(position.sizeUp, position.sizeDown);
  const payout = shares * 1.0;

  // Fees are already estimated at entry, but recalculate for accuracy
  // Fee rate is 0% for all hourly/4h/daily markets!
  const feeRate = config.feeRates?.[config.marketTimeframe] ?? 0.00;
  const fees = position.fees ?? (position.totalCost * feeRate);

  const resolved = resolvePosition(position.id, outcome, payout, fees);

  if (resolved) {
    // Log event
    logEvent('position_resolved', {
      positionId: resolved.id,
      market: resolved.market,
      outcome,
      payout,
      fees,
      actualProfit: resolved.actualProfit,
      roi: resolved.totalCost > 0
        ? ((resolved.actualProfit ?? 0) / resolved.totalCost * 100).toFixed(2) + '%'
        : 'N/A',
    });

    // Notify via Telegram
    await notifyPositionResolved(resolved);

    log.info(
      {
        positionId: resolved.id,
        outcome,
        payout: payout.toFixed(2),
        profit: resolved.actualProfit?.toFixed(2),
      },
      config.paperTrading ? '📝 PAPER position resolved' : '✅ Position resolved'
    );
  }
}

// Symbol to full name mapping (for hourly/daily slug format)
const SYMBOL_NAME_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'xrp',
};

// Month names for slug generation
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Period duration in seconds
const TIMEFRAME_PERIOD_SECONDS: Record<string, number> = {
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  'daily': 24 * 60 * 60,
};

/**
 * Generate slug for hourly/4h/daily markets
 * Format: "bitcoin-up-or-down-february-2-1am-et" (hourly)
 * Format: "bitcoin-up-or-down-february-2-et" (daily)
 */
function generateMarketSlug(symbol: string, date: Date): string {
  const name = SYMBOL_NAME_MAP[symbol.toUpperCase()];
  if (!name) return '';

  // Get ET time components
  const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);

  const month = MONTH_NAMES[etDate.getMonth()];
  const day = etDate.getDate();
  const hour = etDate.getHours();

  if (config.marketTimeframe === 'daily') {
    return `${name}-up-or-down-${month}-${day}-et`;
  }

  const ampm = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 || 12;

  return `${name}-up-or-down-${month}-${day}-${hour12}${ampm}-et`;
}

function getCurrentPeriodET(): Date {
  const now = new Date();
  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 60 * 60;
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);
  const periodMs = period * 1000;
  return new Date(Math.floor(etDate.getTime() / periodMs) * periodMs);
}

// Export for testing
export { checkResolutions };
