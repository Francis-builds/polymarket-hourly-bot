/**
 * Polymarket CLOB API Client
 * Handles balance queries and withdrawals
 */

import { createChildLogger } from './logger.js';
import { config } from './config.js';
import crypto from 'crypto';

const log = createChildLogger('polymarket-api');

const CLOB_API_URL = 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';

// API credentials from environment
const API_KEY = process.env.POLYMARKET_API_KEY || '';
const API_SECRET = process.env.POLYMARKET_API_SECRET || '';
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE || '';

// Polymarket proxy wallet (where deposited funds live)
const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || '';

// USDC contract on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (used by Polymarket)
const USDC_DECIMALS = 6;

interface BalanceResponse {
  balance: string;
}

interface WithdrawResponse {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

// Position from Data API
export interface PolymarketPosition {
  asset: string;           // Token ID
  market: string;          // Condition ID
  outcome: string;         // "Yes" or "No"
  outcomeIndex: number;    // 0 or 1
  size: number;            // Number of shares
  avgPrice: number;        // Average entry price
  currentPrice: number;    // Current market price
  currentValue: number;    // size * currentPrice
  pnl: number;             // Unrealized P&L
  pnlPercent: number;      // P&L as percentage
  marketSlug?: string;     // Market slug for display
  question?: string;       // Market question
  resolved?: boolean;      // Is market resolved
  redeemable?: boolean;    // Has unclaimed proceeds
}

// Full portfolio summary
export interface PortfolioSummary {
  cashAvailable: number;       // USDC available for trading
  positionsValue: number;      // Total value of open positions
  unrealizedPnl: number;       // Total unrealized P&L
  unclaimedProceeds: number;   // Proceeds from resolved markets
  totalPortfolio: number;      // cash + positions + unclaimed
  positions: PolymarketPosition[];
}

// Generate signature for authenticated requests
function generateSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string = ''
): string {
  const message = timestamp + method + requestPath + body;
  const hmac = crypto.createHmac('sha256', Buffer.from(API_SECRET, 'base64'));
  hmac.update(message);
  return hmac.digest('base64');
}

// Make authenticated request to CLOB API
async function authenticatedRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<T | null> {
  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    log.warn('Polymarket API credentials not configured');
    return null;
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = generateSignature(timestamp, method, path, bodyStr);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'POLY_API_KEY': API_KEY,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_PASSPHRASE': API_PASSPHRASE,
    };

    const response = await fetch(`${CLOB_API_URL}${path}`, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, error: errorText }, 'CLOB API error');
      return null;
    }

    return await response.json() as T;
  } catch (error) {
    log.error({ error }, 'Failed to make CLOB API request');
    return null;
  }
}

/**
 * Get USDC.e balance for an address via RPC
 */
async function getUsdcBalanceForAddress(address: string): Promise<number> {
  const rpcUrl = config.polygonRpcUrl;

  try {
    const paddedAddress = address.replace('0x', '').toLowerCase().padStart(64, '0');
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: USDC_ADDRESS,
            data: `0x70a08231000000000000000000000000${paddedAddress.slice(-40)}`,
          },
          'latest',
        ],
      }),
    });

    const data = await response.json() as { result?: string; error?: { message: string } };

    if (data.error) {
      log.warn({ error: data.error, address }, 'Error fetching USDC balance');
      return 0;
    }

    const balanceHex = data.result ?? '0x0';
    const balanceWei = BigInt(balanceHex);
    return Number(balanceWei) / Math.pow(10, USDC_DECIMALS);
  } catch (error) {
    log.error({ error, address }, 'Failed to fetch USDC balance');
    return 0;
  }
}

/**
 * Get USDC balance on Polymarket (checks proxy wallet)
 */
export async function getPolymarketBalance(): Promise<number | null> {
  // Method 1: Check proxy wallet balance directly (most reliable)
  if (POLYMARKET_PROXY_ADDRESS) {
    const balance = await getUsdcBalanceForAddress(POLYMARKET_PROXY_ADDRESS);
    if (balance > 0) {
      log.debug({ balance, source: 'proxy-wallet', address: POLYMARKET_PROXY_ADDRESS }, 'Polymarket balance fetched');
      return balance;
    }
  }

  // Method 2: Try authenticated CLOB API endpoint
  if (API_KEY && API_SECRET && API_PASSPHRASE) {
    const response = await authenticatedRequest<BalanceResponse>('GET', '/balance');
    if (response?.balance) {
      const balance = parseFloat(response.balance);
      log.debug({ balance, source: 'clob-api' }, 'Polymarket balance fetched');
      return balance;
    }
  }

  // Method 3: Fallback to Gamma API (public endpoint with address)
  const address = process.env.POLYMARKET_ADDRESS;
  if (address) {
    try {
      const response = await fetch(`https://gamma-api.polymarket.com/users/${address.toLowerCase()}`);
      if (response.ok) {
        const data = await response.json() as { balance?: string; collateralBalance?: string };
        const balance = parseFloat(data.collateralBalance || data.balance || '0');
        if (balance > 0) {
          log.debug({ balance, source: 'gamma-api' }, 'Polymarket balance fetched');
          return balance;
        }
      }
    } catch (error) {
      log.debug({ error }, 'Gamma API balance fetch failed');
    }
  }

  log.warn('Could not fetch Polymarket balance from any source');
  return null;
}

/**
 * Withdraw USDC from Polymarket to wallet
 * Note: This requires the private key to sign the withdrawal transaction
 */
export async function withdrawFromPolymarket(amount: number): Promise<WithdrawResponse> {
  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    return { success: false, error: 'API credentials not configured. Need API_KEY, API_SECRET, and API_PASSPHRASE.' };
  }

  if (amount <= 0) {
    return { success: false, error: 'Invalid amount' };
  }

  try {
    // Polymarket withdrawal endpoint
    const response = await authenticatedRequest<{ success: boolean; transactionHash?: string }>('POST', '/withdraw', {
      amount: amount.toString(),
    });

    if (response?.success) {
      log.info({ amount, txHash: response.transactionHash }, 'Withdrawal successful');
      return { success: true, transactionHash: response.transactionHash };
    }

    return { success: false, error: 'Withdrawal failed' };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ error, amount }, 'Withdrawal failed');
    return { success: false, error: errorMsg };
  }
}

/**
 * Check if Polymarket API is configured
 */
export function isPolymarketApiConfigured(): boolean {
  return !!(API_KEY && API_SECRET && API_PASSPHRASE);
}

/**
 * Get API configuration status
 */
export function getApiStatus(): { hasKey: boolean; hasSecret: boolean; hasPassphrase: boolean } {
  return {
    hasKey: !!API_KEY,
    hasSecret: !!API_SECRET,
    hasPassphrase: !!API_PASSPHRASE,
  };
}

// Data API response types
interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  cashBalance: string;
  currentValue: string;
  pnl: string;
  realizedPnl: string;
  curPrice: string;
  outcome: string;
  outcomeIndex: string;
  redeemable: string;
  mergeable: string;
  market?: {
    slug?: string;
    question?: string;
    resolved?: boolean;
  };
}

/**
 * Get all positions from Data API
 */
export async function getPositions(): Promise<PolymarketPosition[]> {
  const address = process.env.POLYMARKET_ADDRESS;
  if (!address) {
    log.warn('No POLYMARKET_ADDRESS configured');
    return [];
  }

  try {
    const url = `${DATA_API_URL}/positions?user=${address.toLowerCase()}`;
    log.debug({ url }, 'Fetching positions from Data API');

    const response = await fetch(url);
    if (!response.ok) {
      log.error({ status: response.status }, 'Data API positions error');
      return [];
    }

    const data = await response.json() as DataApiPosition[];

    if (!Array.isArray(data)) {
      log.warn({ data }, 'Unexpected positions response format');
      return [];
    }

    const positions: PolymarketPosition[] = data.map(p => ({
      asset: p.asset,
      market: p.conditionId,
      outcome: p.outcome || (p.outcomeIndex === '0' ? 'Yes' : 'No'),
      outcomeIndex: parseInt(p.outcomeIndex) || 0,
      size: parseFloat(p.size) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      currentPrice: parseFloat(p.curPrice) || 0,
      currentValue: parseFloat(p.currentValue) || 0,
      pnl: parseFloat(p.pnl) || 0,
      pnlPercent: parseFloat(p.avgPrice) > 0
        ? ((parseFloat(p.curPrice) - parseFloat(p.avgPrice)) / parseFloat(p.avgPrice)) * 100
        : 0,
      marketSlug: p.market?.slug,
      question: p.market?.question,
      resolved: p.market?.resolved ?? false,
      redeemable: parseFloat(p.redeemable) > 0,
    }));

    log.info({ count: positions.length }, 'Positions fetched from Data API');
    return positions;
  } catch (error) {
    log.error({ error }, 'Failed to fetch positions');
    return [];
  }
}

/**
 * Get full portfolio summary
 */
export async function getPortfolio(): Promise<PortfolioSummary | null> {
  const address = process.env.POLYMARKET_ADDRESS;
  if (!address) {
    log.warn('No POLYMARKET_ADDRESS configured');
    return null;
  }

  try {
    // Fetch positions and cash balance in parallel
    const [positions, cashBalance] = await Promise.all([
      getPositions(),
      getPolymarketBalance(),
    ]);

    // Calculate portfolio metrics
    const openPositions = positions.filter(p => !p.resolved && p.size > 0);
    const redeemablePositions = positions.filter(p => p.redeemable);

    const positionsValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.pnl, 0);
    const unclaimedProceeds = redeemablePositions.reduce((sum, p) => sum + p.currentValue, 0);

    const cash = cashBalance ?? 0;
    const totalPortfolio = cash + positionsValue + unclaimedProceeds;

    const summary: PortfolioSummary = {
      cashAvailable: cash,
      positionsValue,
      unrealizedPnl,
      unclaimedProceeds,
      totalPortfolio,
      positions: openPositions,
    };

    log.info({
      cash: cash.toFixed(2),
      positions: positionsValue.toFixed(2),
      unclaimed: unclaimedProceeds.toFixed(2),
      total: totalPortfolio.toFixed(2),
    }, '📊 Portfolio summary');

    return summary;
  } catch (error) {
    log.error({ error }, 'Failed to get portfolio');
    return null;
  }
}
