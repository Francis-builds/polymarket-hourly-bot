/**
 * Wallet Balance Monitor
 * Monitors USDC balance on Polygon and notifies on deposits
 */

import { createChildLogger } from './logger.js';
import { config } from './config.js';

const log = createChildLogger('wallet-monitor');

// USDC on Polygon (both versions)
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';  // Native USDC
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
const USDC_DECIMALS = 6;

// Callback for notifications
let onDepositCallback: ((amount: number, newBalance: number) => Promise<void>) | null = null;

// State
let lastBalance: number | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

export function setOnDepositCallback(callback: (amount: number, newBalance: number) => Promise<void>): void {
  onDepositCallback = callback;
}

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

async function getTokenBalance(tokenAddress: string): Promise<number> {
  try {
    const walletAddress = getAddressFromPrivateKey();
    if (!walletAddress) return 0;

    const response = await fetch(config.polygonRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: tokenAddress,
            data: `0x70a08231000000000000000000000000${walletAddress}`,
          },
          'latest',
        ],
      }),
    });

    const data = await response.json() as RpcResponse;

    if (data.error) {
      log.warn({ error: data.error, token: tokenAddress }, 'Error fetching token balance');
      return 0;
    }

    const balanceHex = data.result ?? '0x0';
    const balanceWei = BigInt(balanceHex);
    return Number(balanceWei) / Math.pow(10, USDC_DECIMALS);
  } catch (error) {
    log.error({ error, token: tokenAddress }, 'Failed to fetch token balance');
    return 0;
  }
}

async function getUSDCBalance(): Promise<number> {
  // Check both USDC versions and sum them
  const [nativeBalance, bridgedBalance] = await Promise.all([
    getTokenBalance(USDC_NATIVE),
    getTokenBalance(USDC_BRIDGED),
  ]);

  const total = nativeBalance + bridgedBalance;

  if (nativeBalance > 0 || bridgedBalance > 0) {
    log.debug({
      native: nativeBalance.toFixed(2),
      bridged: bridgedBalance.toFixed(2),
      total: total.toFixed(2),
    }, 'USDC balances');
  }

  return total;
}

function getAddressFromPrivateKey(): string {
  // Extract address from env or derive (simplified - uses POLYMARKET_ADDRESS)
  const address = process.env.POLYMARKET_ADDRESS || '';
  return address.replace('0x', '').toLowerCase();
}

async function checkBalance(): Promise<void> {
  const currentBalance = await getUSDCBalance();

  if (lastBalance !== null && currentBalance > lastBalance) {
    const depositAmount = currentBalance - lastBalance;

    // Only notify for deposits > $0.10 to avoid false positives from rounding
    if (depositAmount >= 0.10) {
      log.info({
        previousBalance: lastBalance.toFixed(2),
        newBalance: currentBalance.toFixed(2),
        deposit: depositAmount.toFixed(2),
      }, '💰 USDC deposit detected!');

      if (onDepositCallback) {
        await onDepositCallback(depositAmount, currentBalance);
      }
    }
  }

  lastBalance = currentBalance;
}

export async function startWalletMonitor(intervalMs: number = 60000): Promise<void> {
  if (!process.env.POLYMARKET_ADDRESS) {
    log.warn('No POLYMARKET_ADDRESS configured, wallet monitor disabled');
    return;
  }

  // Initial balance check
  lastBalance = await getUSDCBalance();
  log.info({ balance: lastBalance.toFixed(2) }, '💼 Wallet monitor started');

  // Check periodically
  monitorInterval = setInterval(checkBalance, intervalMs);
}

export function stopWalletMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function getLastKnownBalance(): number | null {
  return lastBalance;
}
