import WebSocket from 'ws';
import { config } from './config.js';
import { createChildLogger } from './logger.js';
import type { Orderbook, OrderbookLevel } from './types.js';

const log = createChildLogger('market-data');

// Polymarket API endpoints
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Market token IDs
interface MarketTokens {
  symbol: string;
  conditionId: string;
  tokenIdUp: string;
  tokenIdDown: string;
  question: string;
  // Window info for multi-period monitoring
  windowOffset: number;  // 0 = current, 1 = next, 2 = +2
  windowLabel: string;   // "now", "+1", "+2"
  periodTimestamp: number; // Unix timestamp of the period start
}

let marketTokens: Map<string, MarketTokens> = new Map();
let wsConnection: WebSocket | null = null;
let orderbookCache: Map<string, Orderbook> = new Map();
let reconnectTimeout: NodeJS.Timeout | null = null;

// OPTIMIZATION: O(1) lookup from tokenId to market info
let tokenIdLookup: Map<string, {
  symbol: string;
  isUpSide: boolean;
  mapKey: string;        // Key in marketTokens map (e.g., "BTC_1")
  windowOffset: number;  // 0, 1, 2
  windowLabel: string;   // "now", "+1", "+2"
}> = new Map();

type OrderbookCallback = (orderbook: Orderbook) => void;
let orderbookCallbacks: OrderbookCallback[] = [];

// Build the reverse lookup map for fast token matching
function rebuildTokenLookup(): void {
  tokenIdLookup.clear();
  for (const [mapKey, tokens] of marketTokens) {
    tokenIdLookup.set(tokens.tokenIdUp, {
      symbol: tokens.symbol,
      isUpSide: true,
      mapKey,
      windowOffset: tokens.windowOffset,
      windowLabel: tokens.windowLabel,
    });
    tokenIdLookup.set(tokens.tokenIdDown, {
      symbol: tokens.symbol,
      isUpSide: false,
      mapKey,
      windowOffset: tokens.windowOffset,
      windowLabel: tokens.windowLabel,
    });
  }
  log.info({ tokenCount: tokenIdLookup.size, markets: marketTokens.size }, '🔧 Token lookup rebuilt');
}

// Number of future windows to monitor (0 = current only, 2 = current + 2 future)
const FUTURE_WINDOWS_TO_MONITOR = 2;

export async function initMarketData(): Promise<void> {
  log.info('Initializing market data service');

  // In simulation mode, use fake tokens
  if (config.simulateDips) {
    for (const market of config.markets) {
      marketTokens.set(market.symbol, {
        symbol: market.symbol,
        conditionId: `sim_${market.symbol}_condition`,
        tokenIdUp: `sim_${market.symbol}_up`,
        tokenIdDown: `sim_${market.symbol}_down`,
        question: `Simulated ${market.symbol} 15-min`,
        windowOffset: 0,
        windowLabel: 'now',
        periodTimestamp: getCurrentPeriodTimestamp(),
      });
      log.info({ symbol: market.symbol }, '📝 Using simulated market tokens');
    }
    return;
  }

  // Fetch real market tokens for configured symbols
  // Load current + FUTURE_WINDOWS_TO_MONITOR future windows
  log.info({ windows: FUTURE_WINDOWS_TO_MONITOR + 1 }, 'Fetching market data for multiple windows...');

  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 15 * 60;
  const currentTs = getCurrentPeriodTimestamp();

  for (const market of config.markets) {
    // Fetch current and future windows
    for (let offset = 0; offset <= FUTURE_WINDOWS_TO_MONITOR; offset++) {
      const periodTs = currentTs + (offset * period);
      const windowLabel = offset === 0 ? 'now' : `+${offset}`;
      const mapKey = `${market.symbol}_${offset}`; // e.g., "BTC_0", "BTC_1", "BTC_2"

      try {
        const tokens = await fetchMarketTokensForPeriod(market.symbol, periodTs, offset, windowLabel);
        if (tokens) {
          marketTokens.set(mapKey, tokens);
          const windowTime = new Date(periodTs * 1000).toISOString().substring(11, 16);
          log.info({
            symbol: market.symbol,
            window: windowLabel,
            windowTime,
            question: tokens.question.substring(0, 40),
          }, `✅ Market loaded [${windowLabel}]`);
        } else {
          log.debug({ symbol: market.symbol, window: windowLabel }, `⚠️ Window ${windowLabel} not found yet`);
        }
      } catch (error) {
        log.error({ symbol: market.symbol, window: windowLabel, error }, 'Failed to fetch market tokens');
      }
    }
  }

  if (marketTokens.size === 0) {
    throw new Error(`No market tokens loaded - cannot start. Check if ${config.marketTimeframe} markets are active.`);
  }

  log.info({ totalMarkets: marketTokens.size }, '📊 Multi-window market data loaded');

  // Build fast lookup map
  rebuildTokenLookup();
}

// Symbol to slug prefix mapping (for 15m/5m markets with timestamps)
const SYMBOL_SLUG_MAP: Record<string, string> = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  XRP: 'xrp',
};

// Full crypto names for 1h markets (human-readable slugs)
const SYMBOL_FULL_NAME_MAP: Record<string, string> = {
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

// Timeframe slug patterns (for 15m/5m markets)
const TIMEFRAME_SLUG_MAP: Record<string, string> = {
  '15m': 'updown-15m',
  '1h': 'updown-1h',
  '4h': 'updown-4h',
  'daily': 'updown-daily',
};

/**
 * Generate human-readable slug for 1h markets
 * Format: {crypto}-up-or-down-{month}-{day}-{hour}{am/pm}-et
 * Example: bitcoin-up-or-down-february-2-2pm-et
 *
 * IMPORTANT: periodTimestamp is in UTC, but Polymarket uses ET (Eastern Time)
 */
function generateHourlySlug(symbol: string, periodTimestampUTC: number): string {
  const fullName = SYMBOL_FULL_NAME_MAP[symbol.toUpperCase()];
  if (!fullName) {
    throw new Error(`Unknown symbol for hourly slug: ${symbol}`);
  }

  // Convert UTC timestamp to ET (Eastern Time)
  // ET is UTC-5 (EST) or UTC-4 (EDT during daylight saving)
  const utcDate = new Date(periodTimestampUTC * 1000);

  // Use Intl to get the correct ET time
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
  });

  const parts = etFormatter.formatToParts(utcDate);
  const month = parts.find(p => p.type === 'month')?.value?.toLowerCase() || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  const hour = parts.find(p => p.type === 'hour')?.value || '';
  const dayPeriod = parts.find(p => p.type === 'dayPeriod')?.value?.toLowerCase() || '';

  // Format: bitcoin-up-or-down-february-2-2pm-et
  const slug = `${fullName}-up-or-down-${month}-${day}-${hour}${dayPeriod}-et`;

  return slug;
}

// Period duration in seconds
const TIMEFRAME_PERIOD_SECONDS: Record<string, number> = {
  '15m': 15 * 60,      // 15 minutes
  '1h': 60 * 60,       // 1 hour
  '4h': 4 * 60 * 60,   // 4 hours
  'daily': 24 * 60 * 60, // 24 hours
};

// Get current period timestamp for the configured timeframe
function getCurrentPeriodTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 15 * 60;
  return Math.floor(now / period) * period;
}

// Get next period timestamp
function getNextPeriodTimestamp(): number {
  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 15 * 60;
  return getCurrentPeriodTimestamp() + period;
}

// Fetch market tokens for a specific period timestamp
async function fetchMarketTokensForPeriod(
  symbol: string,
  periodTimestamp: number,
  windowOffset: number,
  windowLabel: string
): Promise<MarketTokens | null> {
  try {
    let slugPattern: string;

    // For 1h markets, use human-readable slug format
    if (config.marketTimeframe === '1h') {
      slugPattern = generateHourlySlug(symbol, periodTimestamp);
    } else {
      // For 15m/5m markets, use timestamp-based slug
      const slugPrefix = SYMBOL_SLUG_MAP[symbol.toUpperCase()];
      if (!slugPrefix) {
        log.warn({ symbol }, 'Unknown symbol - no slug mapping');
        return null;
      }
      const timeframeSlug = TIMEFRAME_SLUG_MAP[config.marketTimeframe] || 'updown-15m';
      slugPattern = `${slugPrefix}-${timeframeSlug}-${periodTimestamp}`;
    }

    const url = `${GAMMA_API}/markets?slug=${slugPattern}&active=true`;
    log.debug({ url, slugPattern, window: windowLabel }, 'Fetching market by slug');

    const response = await fetch(url);

    if (!response.ok) {
      log.debug({ status: response.status, slug: slugPattern, window: windowLabel }, 'Market not found');
      return null;
    }

    const markets = (await response.json()) as Array<{
      slug: string;
      question: string;
      conditionId: string;
      clobTokenIds?: string | string[];
      outcomes?: string | string[];
      tokens?: Array<{ token_id: string; outcome: string }>;
    }>;

    if (markets.length === 0) {
      log.debug({ slugPattern, window: windowLabel }, 'No markets returned');
      return null;
    }

    const market = markets[0];

    // Extract token IDs
    let tokenIdUp: string | undefined;
    let tokenIdDown: string | undefined;
    let clobTokenIds: string[] = [];
    let outcomes: string[] = [];

    if (market.clobTokenIds) {
      clobTokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
    }

    if (market.outcomes) {
      outcomes = typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    }

    if (market.tokens && market.tokens.length >= 2) {
      const upToken = market.tokens.find((t) =>
        t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
      );
      const downToken = market.tokens.find((t) =>
        t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
      );
      tokenIdUp = upToken?.token_id;
      tokenIdDown = downToken?.token_id;
    } else if (clobTokenIds.length >= 2 && outcomes.length >= 2) {
      const upIdx = outcomes.findIndex(o =>
        o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
      );
      const downIdx = outcomes.findIndex(o =>
        o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
      );
      if (upIdx >= 0) tokenIdUp = clobTokenIds[upIdx];
      if (downIdx >= 0) tokenIdDown = clobTokenIds[downIdx];
    }

    if (!tokenIdUp || !tokenIdDown) {
      log.warn({ symbol, slug: market.slug, window: windowLabel }, 'Could not extract token IDs');
      return null;
    }

    return {
      symbol,
      conditionId: market.conditionId,
      tokenIdUp,
      tokenIdDown,
      question: market.question,
      windowOffset,
      windowLabel,
      periodTimestamp,
    };
  } catch (error) {
    log.error({ symbol, window: windowLabel, error }, 'Error fetching market tokens for period');
    return null;
  }
}

async function fetchMarketTokens(symbol: string): Promise<MarketTokens | null> {
  try {
    // Try current and next period timestamps
    const timestamps = [getCurrentPeriodTimestamp(), getNextPeriodTimestamp()];

    for (const ts of timestamps) {
      let slugPattern: string;

      // For 1h markets, use human-readable slug format
      if (config.marketTimeframe === '1h') {
        slugPattern = generateHourlySlug(symbol, ts);
      } else {
        // For 15m/5m markets, use timestamp-based slug
        const slugPrefix = SYMBOL_SLUG_MAP[symbol.toUpperCase()];
        if (!slugPrefix) {
          log.warn({ symbol }, 'Unknown symbol - no slug mapping');
          return null;
        }
        const timeframeSlug = TIMEFRAME_SLUG_MAP[config.marketTimeframe] || 'updown-15m';
        slugPattern = `${slugPrefix}-${timeframeSlug}-${ts}`;
      }

      // Query by slug pattern
      const url = `${GAMMA_API}/markets?slug=${slugPattern}&active=true`;
      log.debug({ url, slugPattern }, 'Fetching market by slug');

      const response = await fetch(url);

      if (!response.ok) {
        log.debug({ status: response.status, slug: slugPattern }, 'Market not found by exact slug');
        continue;
      }

      const markets = (await response.json()) as Array<{
        slug: string;
        question: string;
        conditionId: string;
        clobTokenIds?: string | string[];  // Can be JSON string or array
        outcomes?: string | string[];      // Can be JSON string or array
        tokens?: Array<{ token_id: string; outcome: string }>;
      }>;

      if (markets.length === 0) {
        log.debug({ slugPattern }, 'No markets returned for slug');
        continue;
      }

      const market = markets[0];
      log.info({ slug: market.slug, question: market.question?.substring(0, 50), timeframe: config.marketTimeframe }, `Found ${config.marketTimeframe} market`);

      // Extract token IDs
      let tokenIdUp: string | undefined;
      let tokenIdDown: string | undefined;

      // Parse clobTokenIds and outcomes - they may come as JSON strings
      let clobTokenIds: string[] = [];
      let outcomes: string[] = [];

      if (market.clobTokenIds) {
        clobTokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
      }

      if (market.outcomes) {
        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes)
          : market.outcomes;
      }

      log.debug({ clobTokenIds: clobTokenIds.length, outcomes }, 'Parsed market data');

      if (market.tokens && market.tokens.length >= 2) {
        const upToken = market.tokens.find((t) =>
          t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
        );
        const downToken = market.tokens.find((t) =>
          t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
        );
        tokenIdUp = upToken?.token_id;
        tokenIdDown = downToken?.token_id;
      } else if (clobTokenIds.length >= 2 && outcomes.length >= 2) {
        const upIdx = outcomes.findIndex(o =>
          o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
        );
        const downIdx = outcomes.findIndex(o =>
          o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
        );
        if (upIdx >= 0) tokenIdUp = clobTokenIds[upIdx];
        if (downIdx >= 0) tokenIdDown = clobTokenIds[downIdx];
      }

      if (!tokenIdUp || !tokenIdDown) {
        log.warn({ symbol, slug: market.slug, outcomes, tokenCount: clobTokenIds.length }, 'Could not extract token IDs from market');
        continue;
      }

      return {
        symbol,
        conditionId: market.conditionId,
        tokenIdUp,
        tokenIdDown,
        question: market.question,
        windowOffset: 0,
        windowLabel: 'now',
        periodTimestamp: ts,
      };
    }

    // Fallback: search by tag for 1h markets, or slug pattern for 15m
    log.info({ symbol, timeframe: config.marketTimeframe }, 'Trying fallback search...');

    if (config.marketTimeframe === '1h') {
      // For 1h markets, search by tag and filter by symbol
      const fullName = SYMBOL_FULL_NAME_MAP[symbol.toUpperCase()];
      const fallbackUrl = `${GAMMA_API}/events?tag_slug=1H&active=true&closed=false&limit=20`;
      const fallbackResponse = await fetch(fallbackUrl);

      if (fallbackResponse.ok) {
        const events = (await fallbackResponse.json()) as Array<{
          slug: string;
          title: string;
          markets?: Array<{
            slug: string;
            question: string;
            conditionId: string;
            clobTokenIds?: string | string[];
            outcomes?: string | string[];
          }>;
        }>;

        // Find event matching our symbol (e.g., "bitcoin" in slug)
        const matchingEvent = events.find(e =>
          e.slug.toLowerCase().includes(fullName.toLowerCase())
        );

        if (matchingEvent?.markets?.[0]) {
          const market = matchingEvent.markets[0];
          log.info({ slug: market.slug }, 'Found 1h market via tag fallback');

          let clobTokenIds: string[] = [];
          let outcomes: string[] = [];

          if (market.clobTokenIds) {
            clobTokenIds = typeof market.clobTokenIds === 'string'
              ? JSON.parse(market.clobTokenIds)
              : market.clobTokenIds;
          }
          if (market.outcomes) {
            outcomes = typeof market.outcomes === 'string'
              ? JSON.parse(market.outcomes)
              : market.outcomes;
          }

          if (clobTokenIds.length >= 2 && outcomes.length >= 2) {
            const upIdx = outcomes.findIndex(o => o.toLowerCase() === 'up');
            const downIdx = outcomes.findIndex(o => o.toLowerCase() === 'down');

            if (upIdx >= 0 && downIdx >= 0) {
              return {
                symbol,
                conditionId: market.conditionId,
                tokenIdUp: clobTokenIds[upIdx],
                tokenIdDown: clobTokenIds[downIdx],
                question: market.question,
                windowOffset: 0,
                windowLabel: 'now',
                periodTimestamp: getCurrentPeriodTimestamp(),
              };
            }
          }
        }
      }
    } else {
      // For 15m markets, search by slug pattern
      const slugPrefix = SYMBOL_SLUG_MAP[symbol.toUpperCase()];
      const fallbackUrl = `${GAMMA_API}/markets?slug_contains=${slugPrefix}-updown-15m&active=true&closed=false&limit=5`;
      const fallbackResponse = await fetch(fallbackUrl);

      if (fallbackResponse.ok) {
        const markets = (await fallbackResponse.json()) as Array<{
          slug: string;
          question: string;
          conditionId: string;
          clobTokenIds?: string | string[];
          outcomes?: string | string[];
          tokens?: Array<{ token_id: string; outcome: string }>;
        }>;

        if (markets.length > 0) {
          markets.sort((a, b) => b.slug.localeCompare(a.slug));
          const market = markets[0];

          log.info({ slug: market.slug, count: markets.length }, 'Found markets via fallback');

          let tokenIdUp: string | undefined;
          let tokenIdDown: string | undefined;
          let clobTokenIds: string[] = [];
          let outcomes: string[] = [];

          if (market.clobTokenIds) {
            clobTokenIds = typeof market.clobTokenIds === 'string'
              ? JSON.parse(market.clobTokenIds)
              : market.clobTokenIds;
          }
          if (market.outcomes) {
            outcomes = typeof market.outcomes === 'string'
              ? JSON.parse(market.outcomes)
              : market.outcomes;
          }

          if (market.tokens && market.tokens.length >= 2) {
            const upToken = market.tokens.find((t) =>
              t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
            );
            const downToken = market.tokens.find((t) =>
              t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
            );
            tokenIdUp = upToken?.token_id;
            tokenIdDown = downToken?.token_id;
          } else if (clobTokenIds.length >= 2 && outcomes.length >= 2) {
            const upIdx = outcomes.findIndex(o =>
              o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
            );
            const downIdx = outcomes.findIndex(o =>
              o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
            );
            if (upIdx >= 0) tokenIdUp = clobTokenIds[upIdx];
            if (downIdx >= 0) tokenIdDown = clobTokenIds[downIdx];
          }

          if (tokenIdUp && tokenIdDown) {
            return {
              symbol,
              conditionId: market.conditionId,
              tokenIdUp,
              tokenIdDown,
              question: market.question,
              windowOffset: 0,
              windowLabel: 'now',
              periodTimestamp: getCurrentPeriodTimestamp(),
            };
          }
        }
      }
    }

    log.warn({ symbol, timeframe: config.marketTimeframe }, 'Could not find active market');
    return null;
  } catch (error) {
    log.error({ symbol, error }, 'Error fetching market tokens');
    return null;
  }
}

let marketRefreshInterval: NodeJS.Timeout | null = null;
let windowRotationTimeout: NodeJS.Timeout | null = null;
let prefetchTimeout: NodeJS.Timeout | null = null;

// Pre-fetched tokens for next window (ready to switch)
let nextWindowTokens: Map<string, MarketTokens> = new Map();

export async function startOrderbookStream(): Promise<void> {
  log.info('Starting orderbook streams');

  // In simulation mode, generate fake orderbook data
  if (config.simulateDips) {
    log.info('📝 SIMULATION MODE - generating fake orderbook data');
    startDipSimulation();
    return;
  }

  // Connect to real WebSocket
  await connectWebSocket();

  // Schedule precise window rotation instead of polling
  scheduleNextWindowRotation();
}

/**
 * Calculate milliseconds until next window boundary
 * For 15m: :00, :15, :30, :45
 * For 1h: :00 (top of every hour)
 */
function getMsUntilNextWindow(): { msUntilWindow: number; nextWindowTime: Date } {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();

  // Determine window size based on timeframe
  const windowMinutes = config.marketTimeframe === '1h' ? 60 : 15;

  // Find next boundary
  const minutesUntilBoundary = windowMinutes - (minutes % windowMinutes);
  const msUntilBoundary = (minutesUntilBoundary * 60 * 1000) - (seconds * 1000) - ms;

  const nextWindowTime = new Date(now.getTime() + msUntilBoundary);
  return { msUntilWindow: msUntilBoundary, nextWindowTime };
}

/**
 * Schedule the next window rotation with precise timing
 */
function scheduleNextWindowRotation(): void {
  // Clear any existing timeouts
  if (windowRotationTimeout) clearTimeout(windowRotationTimeout);
  if (prefetchTimeout) clearTimeout(prefetchTimeout);

  const { msUntilWindow, nextWindowTime } = getMsUntilNextWindow();
  const msPrefetch = Math.max(0, msUntilWindow - (2 * 60 * 1000)); // 2 minutes before

  // Format times for logging
  const nowStr = new Date().toISOString().substring(11, 19);
  const windowStr = nextWindowTime.toISOString().substring(11, 19);
  const prefetchTime = new Date(Date.now() + msPrefetch);
  const prefetchStr = prefetchTime.toISOString().substring(11, 19);

  log.info({
    currentTime: nowStr,
    nextWindow: windowStr,
    prefetchAt: prefetchStr,
    msUntilPrefetch: msPrefetch,
    msUntilWindow,
  }, '⏰ WINDOW ROTATION SCHEDULED');

  // Schedule pre-fetch (2 minutes before window ends)
  if (msPrefetch > 0) {
    prefetchTimeout = setTimeout(async () => {
      log.info('🔄 Pre-fetching next window tokens...');
      await prefetchNextWindowTokens();
    }, msPrefetch);
  } else {
    // Less than 2 minutes left, prefetch immediately
    log.info('⚡ Less than 2 minutes to window, prefetching NOW');
    prefetchNextWindowTokens();
  }

  // Schedule the actual window switch
  windowRotationTimeout = setTimeout(async () => {
    log.info('🔄 WINDOW ROTATION - Switching to new market tokens');
    await executeWindowRotation();
  }, msUntilWindow);
}

/**
 * Pre-fetch tokens for the next window (15m or 1h depending on config)
 */
async function prefetchNextWindowTokens(): Promise<void> {
  nextWindowTokens.clear();

  // Calculate next period timestamp
  const nextTimestamp = getNextPeriodTimestamp();

  for (const market of config.markets) {
    try {
      let slugPattern: string;

      // For 1h markets, use human-readable slug format
      if (config.marketTimeframe === '1h') {
        slugPattern = generateHourlySlug(market.symbol, nextTimestamp);
      } else {
        // For 15m/5m markets, use timestamp-based slug
        const slugPrefix = SYMBOL_SLUG_MAP[market.symbol.toUpperCase()];
        if (!slugPrefix) continue;
        const timeframeSlug = TIMEFRAME_SLUG_MAP[config.marketTimeframe] || 'updown-15m';
        slugPattern = `${slugPrefix}-${timeframeSlug}-${nextTimestamp}`;
      }

      const url = `${GAMMA_API}/markets?slug=${slugPattern}&active=true`;
      log.debug({ url, slugPattern }, 'Pre-fetching next window market');

      const response = await fetch(url);
      if (!response.ok) {
        log.warn({ symbol: market.symbol, status: response.status }, 'Next window market not found yet');
        continue;
      }

      const markets = (await response.json()) as Array<{
        slug: string;
        question: string;
        conditionId: string;
        clobTokenIds?: string | string[];
        outcomes?: string | string[];
        tokens?: Array<{ token_id: string; outcome: string }>;
      }>;

      if (markets.length === 0) {
        log.warn({ symbol: market.symbol, slugPattern }, 'No markets returned for next window');
        continue;
      }

      const marketData = markets[0];

      // Parse tokens
      let tokenIdUp: string | undefined;
      let tokenIdDown: string | undefined;
      let clobTokenIds: string[] = [];
      let outcomes: string[] = [];

      if (marketData.clobTokenIds) {
        clobTokenIds = typeof marketData.clobTokenIds === 'string'
          ? JSON.parse(marketData.clobTokenIds)
          : marketData.clobTokenIds;
      }

      if (marketData.outcomes) {
        outcomes = typeof marketData.outcomes === 'string'
          ? JSON.parse(marketData.outcomes)
          : marketData.outcomes;
      }

      if (marketData.tokens && marketData.tokens.length >= 2) {
        const upToken = marketData.tokens.find((t) =>
          t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
        );
        const downToken = marketData.tokens.find((t) =>
          t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
        );
        tokenIdUp = upToken?.token_id;
        tokenIdDown = downToken?.token_id;
      } else if (clobTokenIds.length >= 2 && outcomes.length >= 2) {
        const upIdx = outcomes.findIndex(o =>
          o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
        );
        const downIdx = outcomes.findIndex(o =>
          o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
        );
        if (upIdx >= 0) tokenIdUp = clobTokenIds[upIdx];
        if (downIdx >= 0) tokenIdDown = clobTokenIds[downIdx];
      }

      if (tokenIdUp && tokenIdDown) {
        nextWindowTokens.set(market.symbol, {
          symbol: market.symbol,
          conditionId: marketData.conditionId,
          tokenIdUp,
          tokenIdDown,
          question: marketData.question,
          windowOffset: 0, // Will be "current" after rotation
          windowLabel: 'now',
          periodTimestamp: nextTimestamp,
        });
        log.info({
          symbol: market.symbol,
          question: marketData.question?.substring(0, 50),
        }, '✅ Next window tokens pre-fetched');
      }
    } catch (error) {
      log.error({ symbol: market.symbol, error }, 'Error pre-fetching next window');
    }
  }

  log.info({ prefetchedCount: nextWindowTokens.size, total: config.markets.length }, '📦 Pre-fetch complete');
}

/**
 * Execute the window rotation - switch to new tokens
 */
async function executeWindowRotation(): Promise<void> {
  // If we have pre-fetched tokens, use them
  if (nextWindowTokens.size > 0) {
    log.info({ newTokenCount: nextWindowTokens.size }, '🔄 Switching to pre-fetched tokens');

    // Update main token map
    for (const [symbol, tokens] of nextWindowTokens) {
      const oldTokens = marketTokens.get(symbol);
      log.info({
        symbol,
        oldQuestion: oldTokens?.question?.substring(0, 40),
        newQuestion: tokens.question?.substring(0, 40),
      }, '↔️ Token switch');
      marketTokens.set(symbol, tokens);
    }

    nextWindowTokens.clear();
  } else {
    // No pre-fetched tokens, do a fresh fetch
    log.warn('⚠️ No pre-fetched tokens, fetching fresh...');
    for (const market of config.markets) {
      const tokens = await fetchMarketTokens(market.symbol);
      if (tokens) {
        marketTokens.set(market.symbol, tokens);
      }
    }
  }

  // Rebuild lookup and reconnect WebSocket
  rebuildTokenLookup();

  if (wsConnection) {
    log.info('🔌 Reconnecting WebSocket with new tokens...');
    wsConnection.close();
    wsConnection = null;
  }

  await connectWebSocket();

  // Schedule next rotation
  scheduleNextWindowRotation();
}

async function refreshMarketTokens(): Promise<void> {
  log.info('Checking for new market periods...');

  for (const market of config.markets) {
    const currentTokens = marketTokens.get(market.symbol);
    const newTokens = await fetchMarketTokens(market.symbol);

    if (newTokens && currentTokens) {
      // Check if tokens changed (new market period)
      if (newTokens.tokenIdUp !== currentTokens.tokenIdUp) {
        log.info({
          symbol: market.symbol,
          oldQuestion: currentTokens.question?.substring(0, 40),
          newQuestion: newTokens.question?.substring(0, 40),
        }, '🔄 Market period changed, updating tokens');

        marketTokens.set(market.symbol, newTokens);
        rebuildTokenLookup(); // Rebuild fast lookup

        // Reconnect WebSocket with new tokens
        if (wsConnection) {
          wsConnection.close();
          wsConnection = null;
          await connectWebSocket();
        }
        break; // One reconnection is enough for all new tokens
      }
    } else if (newTokens && !currentTokens) {
      marketTokens.set(market.symbol, newTokens);
      rebuildTokenLookup(); // Rebuild fast lookup
      log.info({ symbol: market.symbol }, 'New market tokens added');
    }
  }
}

async function connectWebSocket(): Promise<void> {
  // Collect all token IDs to subscribe
  const allTokenIds: string[] = [];
  for (const tokens of marketTokens.values()) {
    allTokenIds.push(tokens.tokenIdUp, tokens.tokenIdDown);
  }

  if (allTokenIds.length === 0) {
    log.error('No token IDs to subscribe to');
    return;
  }

  log.info({ tokenCount: allTokenIds.length }, 'Connecting to Polymarket WebSocket...');

  try {
    wsConnection = new WebSocket(CLOB_WS);

    wsConnection.on('open', () => {
      log.info('✅ WebSocket connected to Polymarket');

      // Subscribe to orderbook updates for all tokens
      // Try the MARKET channel subscription format
      const subscribeMsg = {
        auth: null,
        type: 'MARKET',
        assets_ids: allTokenIds,
      };

      wsConnection?.send(JSON.stringify(subscribeMsg));
      log.info({ assets: allTokenIds.length, msg: JSON.stringify(subscribeMsg).substring(0, 100) }, 'Subscribed to orderbook updates');
    });

    wsConnection.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        handleWebSocketMessage(message);
      } catch (error) {
        log.error({ error, data: data.toString().substring(0, 100) }, 'Error parsing WebSocket message');
      }
    });

    wsConnection.on('error', (error) => {
      log.error({ error }, 'WebSocket error');
    });

    wsConnection.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed, reconnecting in 5s...');
      wsConnection = null;

      // Reconnect after delay
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => {
        connectWebSocket();
      }, 5000);
    });

  } catch (error) {
    log.error({ error }, 'Failed to connect WebSocket');

    // Retry after delay
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
      connectWebSocket();
    }, 5000);
  }
}

let messageCount = 0;
let updateCount = 0;
let lastResetTime = Date.now();

// Get and reset WebSocket message counts (for 15-min summaries)
export function getAndResetMessageCounts(): { messages: number; updates: number; periodMs: number } {
  const now = Date.now();
  const result = {
    messages: messageCount,
    updates: updateCount,
    periodMs: now - lastResetTime,
  };
  messageCount = 0;
  updateCount = 0;
  lastResetTime = now;
  return result;
}

// Get current counts without resetting (for debugging)
export function getMessageCounts(): { messages: number; updates: number } {
  return { messages: messageCount, updates: updateCount };
}

function handleWebSocketMessage(message: unknown): void {
  messageCount++;

  // Handle arrays of updates
  if (Array.isArray(message)) {
    for (const update of message) {
      if (update && typeof update === 'object' && 'asset_id' in update) {
        handleOrderbookUpdate(update as Record<string, unknown>);
      }
    }
    return;
  }

  // Handle object messages
  if (message && typeof message === 'object') {
    const msg = message as Record<string, unknown>;

    // Handle price_changes format (the ACTUAL format Polymarket sends!)
    if ('price_changes' in msg && Array.isArray(msg.price_changes)) {
      for (const change of msg.price_changes as Array<Record<string, unknown>>) {
        if (change.asset_id) {
          handlePriceChange(change);
        }
      }
      return;
    }

    // Handle book/book_snapshot format
    const eventType = (msg.event_type ?? msg.type) as string;
    if (eventType === 'book' || eventType === 'book_snapshot') {
      handleOrderbookUpdate(msg);
    } else if (msg.type === 'subscribed') {
      log.info({ channel: msg.channel, market: msg.market }, 'Subscription confirmed');
    } else if (msg.type === 'error') {
      log.error({ msg }, 'WebSocket error message');
    }
  }

  // Log every 5000 messages
  if (messageCount % 5000 === 0) {
    log.info({ messageCount, updateCount }, 'WebSocket stats');
  }
}

// Handle price_change messages - update the best bid/ask
function handlePriceChange(change: Record<string, unknown>): void {
  const assetId = change.asset_id as string;
  if (!assetId) return;

  // FAST O(1) LOOKUP
  const tokenInfo = tokenIdLookup.get(assetId);
  if (!tokenInfo) return; // Not our market

  updateCount++;
  const { symbol, isUpSide, mapKey, windowOffset, windowLabel } = tokenInfo;

  // Get or create orderbook (using mapKey to separate windows)
  let orderbook = orderbookCache.get(mapKey);
  if (!orderbook) {
    orderbook = {
      market: symbol,
      timestamp: Date.now(),
      UP: { bids: [], asks: [] },
      DOWN: { bids: [], asks: [] },
      windowOffset,
      windowLabel,
    };
  }

  // Update best bid/ask from price_change
  const price = parseFloat(change.price as string);
  const size = parseFloat(change.size as string);
  const side = change.side as string;
  const bestBid = change.best_bid ? parseFloat(change.best_bid as string) : undefined;
  const bestAsk = change.best_ask ? parseFloat(change.best_ask as string) : undefined;

  // Update the appropriate side
  if (isUpSide) {
    if (bestBid !== undefined) {
      orderbook.UP.bids = [{ price: bestBid, size: 1000 }]; // Size approximated
    }
    if (bestAsk !== undefined) {
      orderbook.UP.asks = [{ price: bestAsk, size: 1000 }];
    } else if (side === 'SELL' || side === 'sell') {
      orderbook.UP.asks = [{ price, size }];
    }
  } else {
    if (bestBid !== undefined) {
      orderbook.DOWN.bids = [{ price: bestBid, size: 1000 }];
    }
    if (bestAsk !== undefined) {
      orderbook.DOWN.asks = [{ price: bestAsk, size: 1000 }];
    } else if (side === 'SELL' || side === 'sell') {
      orderbook.DOWN.asks = [{ price, size }];
    }
  }

  orderbook.timestamp = Date.now();
  orderbookCache.set(mapKey, orderbook);

  // Log occasionally (every 5000 updates = ~50 seconds)
  if (updateCount % 5000 === 0) {
    const upAsk = orderbook.UP.asks[0]?.price ?? 0;
    const downAsk = orderbook.DOWN.asks[0]?.price ?? 0;
    log.info({
      symbol,
      window: windowLabel,
      upAsk: upAsk.toFixed(3),
      downAsk: downAsk.toFixed(3),
      total: (upAsk + downAsk).toFixed(3),
      updateCount,
    }, '📈 Price update');
  }

  // Notify callbacks for dip detection
  for (const callback of orderbookCallbacks) {
    callback(orderbook);
  }
}

function handleOrderbookUpdate(data: Record<string, unknown>): void {
  const assetId = data.asset_id as string;
  if (!assetId) return;

  // FAST O(1) LOOKUP - skip if not our token
  const tokenInfo = tokenIdLookup.get(assetId);
  if (!tokenInfo) return; // Not our market, skip immediately

  updateCount++;
  const { symbol: foundSymbol, isUpSide, mapKey, windowOffset, windowLabel } = tokenInfo;

  // Log matches for debugging
  if (updateCount < 20) {
    log.info({ symbol: foundSymbol, window: windowLabel, side: isUpSide ? 'UP' : 'DOWN' }, 'Orderbook update matched');
  }

  // Parse bids and asks
  const bids = (data.bids as Array<{ price: string; size: string }>) ?? [];
  const asks = (data.asks as Array<{ price: string; size: string }>) ?? [];

  const parsedBids: OrderbookLevel[] = bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  })).sort((a, b) => b.price - a.price); // Highest bid first

  const parsedAsks: OrderbookLevel[] = asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  })).sort((a, b) => a.price - b.price); // Lowest ask first

  // Get or create orderbook for this market (using mapKey to separate windows)
  let orderbook = orderbookCache.get(mapKey);

  if (!orderbook) {
    orderbook = {
      market: foundSymbol,
      timestamp: Date.now(),
      UP: { bids: [], asks: [] },
      DOWN: { bids: [], asks: [] },
      windowOffset,
      windowLabel,
    };
  }

  // Update the appropriate side
  if (isUpSide) {
    orderbook.UP = { bids: parsedBids, asks: parsedAsks };
  } else {
    orderbook.DOWN = { bids: parsedBids, asks: parsedAsks };
  }

  orderbook.timestamp = Date.now();
  orderbookCache.set(mapKey, orderbook);

  // Log occasionally to show we're receiving data
  if (Math.random() < 0.01) { // 1% of updates
    const upAsk = orderbook.UP.asks[0]?.price ?? 0;
    const downAsk = orderbook.DOWN.asks[0]?.price ?? 0;
    const total = upAsk + downAsk;
    log.debug({
      market: foundSymbol,
      upAsk: upAsk.toFixed(3),
      downAsk: downAsk.toFixed(3),
      total: total.toFixed(3),
    }, 'Orderbook update');
  }

  // Notify callbacks
  for (const callback of orderbookCallbacks) {
    callback(orderbook);
  }
}

// Simulation mode: generate random orderbook updates with occasional dips
let simulationInterval: NodeJS.Timeout | null = null;

function startDipSimulation(): void {
  const symbols = config.markets.map((m) => m.symbol);

  simulationInterval = setInterval(() => {
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];

    // Generate random prices around 0.50
    let priceUp = 0.48 + Math.random() * 0.08;
    let priceDown = 0.48 + Math.random() * 0.08;

    // 10% chance of a dip (total < 0.96)
    if (Math.random() < 0.10) {
      const dipAmount = 0.04 + Math.random() * 0.06;
      priceUp = priceUp - dipAmount / 2;
      priceDown = priceDown - dipAmount / 2;
      log.info({ symbol, total: (priceUp + priceDown).toFixed(3) }, '📝 Simulating DIP');
    }

    const orderbook: Orderbook = {
      market: symbol,
      timestamp: Date.now(),
      UP: {
        bids: [{ price: priceUp - 0.01, size: 100 + Math.random() * 500 }],
        asks: [{ price: priceUp, size: 100 + Math.random() * 500 }],
      },
      DOWN: {
        bids: [{ price: priceDown - 0.01, size: 100 + Math.random() * 500 }],
        asks: [{ price: priceDown, size: 100 + Math.random() * 500 }],
      },
    };

    orderbookCache.set(symbol, orderbook);

    for (const callback of orderbookCallbacks) {
      callback(orderbook);
    }
  }, 2000);
}

function stopDipSimulation(): void {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}

export function onOrderbookUpdate(callback: OrderbookCallback): void {
  orderbookCallbacks.push(callback);
}

// Get orderbook by mapKey (e.g., "BTC_0") or symbol (returns current window)
export function getOrderbook(symbolOrKey: string): Orderbook | undefined {
  // First try as mapKey
  if (orderbookCache.has(symbolOrKey)) {
    return orderbookCache.get(symbolOrKey);
  }
  // Fallback: try as symbol with current window
  return orderbookCache.get(`${symbolOrKey}_0`);
}

// Get all orderbooks (for multi-window monitoring)
export function getAllOrderbooks(): Orderbook[] {
  return Array.from(orderbookCache.values());
}

// Get market tokens by mapKey (e.g., "BTC_1") or symbol (returns current window)
export function getMarketTokens(symbolOrKey: string): MarketTokens | undefined {
  // First try as mapKey
  if (marketTokens.has(symbolOrKey)) {
    return marketTokens.get(symbolOrKey);
  }
  // Fallback: try as symbol with current window
  return marketTokens.get(`${symbolOrKey}_0`);
}

// Get market tokens for a specific window
export function getMarketTokensForWindow(symbol: string, windowOffset: number): MarketTokens | undefined {
  return marketTokens.get(`${symbol}_${windowOffset}`);
}

export function getAllMarketTokens(): MarketTokens[] {
  return Array.from(marketTokens.values());
}

export function stopOrderbookStreams(): void {
  stopDipSimulation();

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (marketRefreshInterval) {
    clearInterval(marketRefreshInterval);
    marketRefreshInterval = null;
  }

  // Clear window rotation timeouts
  if (windowRotationTimeout) {
    clearTimeout(windowRotationTimeout);
    windowRotationTimeout = null;
  }

  if (prefetchTimeout) {
    clearTimeout(prefetchTimeout);
    prefetchTimeout = null;
  }

  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
    log.info('WebSocket closed');
  }

  orderbookCallbacks = [];
  nextWindowTokens.clear();
}

export function injectOrderbook(orderbook: Orderbook): void {
  orderbookCache.set(orderbook.market, orderbook);

  for (const callback of orderbookCallbacks) {
    callback(orderbook);
  }
}
