/**
 * Order Pre-Signer
 *
 * Pre-signs orders when prices approach the threshold to reduce execution latency.
 * When a dip is detected, we can immediately post the pre-signed order instead of
 * waiting for the signing process (~200-400ms savings).
 */

import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { getThreshold, getMaxTotalCost } from './runtime-config.js';
import { getMarketTokens } from './market-data.js';

const log = createChildLogger('presigner');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clobClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Side: any = null;

// Cache of pre-signed orders: Map<cacheKey, {signedOrder, createdAt, params}>
interface PreSignedOrder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signedOrder: any;
  createdAt: number;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

const orderCache = new Map<string, PreSignedOrder>();

// Track which markets are "hot" (approaching threshold)
const hotMarkets = new Set<string>();

// Pre-sign interval
let presignInterval: NodeJS.Timeout | null = null;

// Stats
let presignCount = 0;
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Initialize the pre-signer with the CLOB client
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initPresigner(client: any, sideEnum: any): void {
  clobClient = client;
  Side = sideEnum;

  // Start pre-signing loop
  presignInterval = setInterval(presignHotMarkets, 500); // Every 500ms

  log.info('Order pre-signer initialized');
}

/**
 * Stop the pre-signer
 */
export function stopPresigner(): void {
  if (presignInterval) {
    clearInterval(presignInterval);
    presignInterval = null;
  }
  orderCache.clear();
  hotMarkets.clear();
  log.info({ presignCount, cacheHits, cacheMisses }, 'Pre-signer stopped');
}

/**
 * Mark a market as "hot" (approaching threshold, worth pre-signing)
 */
export function markMarketHot(market: string, totalCost: number): void {
  const threshold = getThreshold();
  const maxCost = getMaxTotalCost();

  // Consider "hot" if within 5% of threshold
  if (totalCost < threshold + 0.05 && totalCost <= maxCost + 0.02) {
    if (!hotMarkets.has(market)) {
      hotMarkets.add(market);
      log.debug({ market, totalCost, threshold }, 'Market marked hot for pre-signing');
    }
  } else {
    if (hotMarkets.has(market)) {
      hotMarkets.delete(market);
      // Clear cached orders for this market
      clearMarketCache(market);
    }
  }
}

/**
 * Clear cached orders for a specific market
 */
function clearMarketCache(market: string): void {
  for (const [key] of orderCache) {
    if (key.startsWith(market + ':')) {
      orderCache.delete(key);
    }
  }
}

/**
 * Generate cache key
 */
function getCacheKey(market: string, side: 'UP' | 'DOWN', orderSide: 'BUY' | 'SELL', price: number, size: number): string {
  // Round price to 2 decimals, size to 0 decimals for cache key
  const priceKey = price.toFixed(2);
  const sizeKey = Math.round(size);
  return `${market}:${side}:${orderSide}:${priceKey}:${sizeKey}`;
}

/**
 * Get a pre-signed order from cache if available
 */
export function getPresignedOrder(
  market: string,
  side: 'UP' | 'DOWN',
  orderSide: 'BUY' | 'SELL',
  price: number,
  size: number
): PreSignedOrder | null {
  const key = getCacheKey(market, side, orderSide, price, size);
  const cached = orderCache.get(key);

  if (cached) {
    // Check if order is still fresh (< 30 seconds old)
    const age = Date.now() - cached.createdAt;
    if (age < 30000) {
      cacheHits++;
      log.debug({ market, side, price, size, ageMs: age }, 'Pre-signed order cache HIT');
      return cached;
    } else {
      // Stale, remove from cache
      orderCache.delete(key);
    }
  }

  cacheMisses++;
  return null;
}

/**
 * Pre-sign orders for hot markets
 */
async function presignHotMarkets(): Promise<void> {
  if (!clobClient || hotMarkets.size === 0) return;

  for (const market of hotMarkets) {
    try {
      const tokens = getMarketTokens(market);
      if (!tokens) continue;

      // Pre-sign at price points around common dip levels
      const priceLevels = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
      const sizes = [50, 100]; // Pre-sign for common sizes

      for (const size of sizes) {
        for (const price of priceLevels) {
          // Pre-sign UP side
          await presignOrder(market, 'UP', tokens.tokenIdUp, 'BUY', price, size);
          // Pre-sign DOWN side
          await presignOrder(market, 'DOWN', tokens.tokenIdDown, 'BUY', price, size);
        }
      }
    } catch (error) {
      log.error({ error, market }, 'Error pre-signing for market');
    }
  }
}

/**
 * Pre-sign a single order
 */
async function presignOrder(
  market: string,
  side: 'UP' | 'DOWN',
  tokenId: string,
  orderSide: 'BUY' | 'SELL',
  price: number,
  size: number
): Promise<void> {
  const key = getCacheKey(market, side, orderSide, price, size);

  // Skip if already cached and fresh
  const existing = orderCache.get(key);
  if (existing && Date.now() - existing.createdAt < 25000) {
    return; // Still fresh, don't re-sign
  }

  try {
    // Fee rate in basis points - 0 for hourly markets (free trading)
    const feeRateBps = 0;

    const signedOrder = await clobClient.createOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: orderSide === 'BUY' ? Side.BUY : Side.SELL,
        feeRateBps,
      },
      { negRisk: false, tickSize: '0.01' }
    );

    orderCache.set(key, {
      signedOrder,
      createdAt: Date.now(),
      tokenId,
      side: orderSide,
      price,
      size,
    });

    presignCount++;

    if (presignCount % 100 === 0) {
      log.debug({ presignCount, cacheSize: orderCache.size, cacheHits, cacheMisses }, 'Pre-sign stats');
    }
  } catch (error) {
    // Silently ignore pre-sign failures - not critical
    log.debug({ error, market, side, price, size }, 'Pre-sign failed (non-critical)');
  }
}

/**
 * Post a pre-signed order directly
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function postPresignedOrder(presigned: PreSignedOrder, orderType: any): Promise<any> {
  if (!clobClient) {
    throw new Error('CLOB client not initialized');
  }

  return await clobClient.postOrder(presigned.signedOrder, orderType);
}

/**
 * Get pre-signer stats
 */
export function getPresignerStats(): { presignCount: number; cacheSize: number; cacheHits: number; cacheMisses: number; hotMarkets: string[] } {
  return {
    presignCount,
    cacheSize: orderCache.size,
    cacheHits,
    cacheMisses,
    hotMarkets: Array.from(hotMarkets),
  };
}
