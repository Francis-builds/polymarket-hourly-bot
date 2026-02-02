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
}

let marketTokens: Map<string, MarketTokens> = new Map();
let wsConnection: WebSocket | null = null;
let orderbookCache: Map<string, Orderbook> = new Map();
let reconnectTimeout: NodeJS.Timeout | null = null;

type OrderbookCallback = (orderbook: Orderbook) => void;
let orderbookCallbacks: OrderbookCallback[] = [];

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
        question: `Simulated ${market.symbol} ${config.marketTimeframe}`,
      });
      log.info({ symbol: market.symbol }, '📝 Using simulated market tokens');
    }
    return;
  }

  // Fetch real market tokens for configured symbols
  log.info('Fetching real market data from Polymarket...');

  for (const market of config.markets) {
    try {
      const tokens = await fetchMarketTokens(market.symbol);
      if (tokens) {
        marketTokens.set(market.symbol, tokens);
        log.info({
          symbol: market.symbol,
          question: tokens.question.substring(0, 50),
          tokenUp: tokens.tokenIdUp.substring(0, 20) + '...',
          tokenDown: tokens.tokenIdDown.substring(0, 20) + '...',
        }, '✅ Market tokens loaded');
      } else {
        log.warn({ symbol: market.symbol }, '⚠️ Market not found - may not be active');
      }
    } catch (error) {
      log.error({ symbol: market.symbol, error }, 'Failed to fetch market tokens');
    }
  }

  if (marketTokens.size === 0) {
    throw new Error(`No market tokens loaded - cannot start. Check if ${config.marketTimeframe} markets are active.`);
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
  '1h': 60 * 60,       // 1 hour
  '4h': 4 * 60 * 60,   // 4 hours
  'daily': 24 * 60 * 60, // 24 hours
};

// Get current period start in ET timezone
function getCurrentPeriodET(): Date {
  const now = new Date();
  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 60 * 60;

  // Convert to ET (UTC-5 or UTC-4 during DST)
  // For simplicity, use America/New_York timezone
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);

  // Align to period boundary
  const periodMs = period * 1000;
  const aligned = new Date(Math.floor(etDate.getTime() / periodMs) * periodMs);

  return aligned;
}

// Get next period start in ET
function getNextPeriodET(): Date {
  const current = getCurrentPeriodET();
  const period = TIMEFRAME_PERIOD_SECONDS[config.marketTimeframe] || 60 * 60;
  return new Date(current.getTime() + period * 1000);
}

/**
 * Generate slug for hourly/4h/daily markets
 * Format: "bitcoin-up-or-down-february-2-1am-et" (hourly)
 * Format: "bitcoin-up-or-down-february-2-4am-et" (4h)
 * Format: "bitcoin-up-or-down-february-2-et" (daily)
 */
function generateMarketSlug(symbol: string, date: Date): string {
  const name = SYMBOL_NAME_MAP[symbol.toUpperCase()];
  if (!name) {
    log.warn({ symbol }, 'Unknown symbol for slug generation');
    return '';
  }

  // Get ET time components
  const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);

  const month = MONTH_NAMES[etDate.getMonth()];
  const day = etDate.getDate();
  const hour = etDate.getHours();

  if (config.marketTimeframe === 'daily') {
    // Daily format: "bitcoin-up-or-down-february-2-et"
    return `${name}-up-or-down-${month}-${day}-et`;
  }

  // Hourly/4h format: "bitcoin-up-or-down-february-2-1am-et"
  const ampm = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 || 12;

  return `${name}-up-or-down-${month}-${day}-${hour12}${ampm}-et`;
}

async function fetchMarketTokens(symbol: string): Promise<MarketTokens | null> {
  try {
    const symbolName = SYMBOL_NAME_MAP[symbol.toUpperCase()];
    if (!symbolName) {
      log.warn({ symbol }, 'Unknown symbol - no name mapping');
      return null;
    }

    // Try current and next period times in ET
    const periods = [getCurrentPeriodET(), getNextPeriodET()];

    for (const periodDate of periods) {
      const slugPattern = generateMarketSlug(symbol, periodDate);
      if (!slugPattern) continue;

      // Query by slug pattern
      const url = `${GAMMA_API}/markets?slug=${slugPattern}&active=true`;
      log.debug({ url, slugPattern, periodET: periodDate.toISOString() }, 'Fetching market by slug');

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
      };
    }

    // Fallback: search by slug_contains pattern for hourly/4h/daily markets
    log.info({ symbol, timeframe: config.marketTimeframe }, 'Trying fallback search by slug pattern...');
    const fallbackUrl = `${GAMMA_API}/markets?slug_contains=${symbolName}-up-or-down&active=true&closed=false&limit=10`;

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
        // Sort by slug (timestamp) descending to get most recent
        markets.sort((a, b) => b.slug.localeCompare(a.slug));
        const market = markets[0];

        log.info({ slug: market.slug, count: markets.length }, 'Found markets via fallback');

        let tokenIdUp: string | undefined;
        let tokenIdDown: string | undefined;

        // Parse clobTokenIds and outcomes
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
          };
        }
      }
    }

    log.warn({ symbol, timeframe: config.marketTimeframe }, `Could not find active ${config.marketTimeframe} market`);
    return null;
  } catch (error) {
    log.error({ symbol, error }, 'Error fetching market tokens');
    return null;
  }
}

let marketRefreshInterval: NodeJS.Timeout | null = null;

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

  // Schedule market token refresh every 5 minutes to catch new 15-min periods
  marketRefreshInterval = setInterval(async () => {
    await refreshMarketTokens();
  }, 5 * 60 * 1000); // Every 5 minutes
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

function handleWebSocketMessage(message: unknown): void {
  messageCount++;

  // Polymarket sends arrays of orderbook updates
  if (Array.isArray(message)) {
    for (const update of message) {
      if (update && typeof update === 'object' && 'asset_id' in update) {
        handleOrderbookUpdate(update as Record<string, unknown>);
      }
    }
    return;
  }

  // Handle object messages (subscription confirmations, errors, etc.)
  if (message && typeof message === 'object') {
    const msg = message as Record<string, unknown>;
    const msgType = msg.type as string;

    if (msgType === 'book' || msgType === 'book_snapshot') {
      handleOrderbookUpdate(msg);
    } else if (msgType === 'subscribed') {
      log.info({ channel: msg.channel, market: msg.market }, 'Subscription confirmed');
    } else if (msgType === 'error') {
      log.error({ msg }, 'WebSocket error message');
    }
  }

  // Log every 1000 messages
  if (messageCount % 1000 === 0) {
    log.info({ messageCount, updateCount }, 'WebSocket stats');
  }
}

function handleOrderbookUpdate(data: Record<string, unknown>): void {
  const assetId = data.asset_id as string;
  if (!assetId) return;

  updateCount++;

  // Find which market this token belongs to
  let foundSymbol: string | null = null;
  let foundTokens: MarketTokens | null = null;
  let isUpSide = false;

  for (const [symbol, tokens] of marketTokens) {
    if (tokens.tokenIdUp === assetId) {
      foundSymbol = symbol;
      foundTokens = tokens;
      isUpSide = true;
      break;
    } else if (tokens.tokenIdDown === assetId) {
      foundSymbol = symbol;
      foundTokens = tokens;
      isUpSide = false;
      break;
    }
  }

  if (!foundSymbol || !foundTokens) {
    // Log first few unknown tokens for debugging
    if (updateCount < 20) {
      log.debug({ assetId: assetId.substring(0, 30) + '...' }, 'Unknown asset_id');
    }
    return;
  }

  // Log first match for each symbol
  if (updateCount < 50) {
    log.info({ symbol: foundSymbol, side: isUpSide ? 'UP' : 'DOWN' }, 'Orderbook update matched');
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

  // Get or create orderbook for this market
  let orderbook = orderbookCache.get(foundSymbol);

  if (!orderbook) {
    orderbook = {
      market: foundSymbol,
      timestamp: Date.now(),
      UP: { bids: [], asks: [] },
      DOWN: { bids: [], asks: [] },
    };
  }

  // Update the appropriate side
  if (isUpSide) {
    orderbook.UP = { bids: parsedBids, asks: parsedAsks };
  } else {
    orderbook.DOWN = { bids: parsedBids, asks: parsedAsks };
  }

  orderbook.timestamp = Date.now();
  orderbookCache.set(foundSymbol, orderbook);

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

export function getOrderbook(symbol: string): Orderbook | undefined {
  return orderbookCache.get(symbol);
}

export function getMarketTokens(symbol: string): MarketTokens | undefined {
  return marketTokens.get(symbol);
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

  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
    log.info('WebSocket closed');
  }

  orderbookCallbacks = [];
}

export function injectOrderbook(orderbook: Orderbook): void {
  orderbookCache.set(orderbook.market, orderbook);

  for (const callback of orderbookCallbacks) {
    callback(orderbook);
  }
}
