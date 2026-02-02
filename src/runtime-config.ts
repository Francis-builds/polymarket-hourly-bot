/**
 * Runtime Configuration
 * Mutable config values that can be changed via Telegram commands
 */

import { config } from './config.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('runtime-config');

// Mutable values initialized from static config
let threshold = config.trading.threshold;
let maxPositionSize = config.trading.maxPositionSize;
let maxOpenPositions = config.trading.maxOpenPositions;
let marketTimeframe: '1h' | '4h' | 'daily' = config.marketTimeframe as '1h' | '4h' | 'daily';

// Getters
export function getThreshold(): number {
  return threshold;
}

export function getMaxPositionSize(): number {
  return maxPositionSize;
}

export function getMaxOpenPositions(): number {
  return maxOpenPositions;
}

// Setters
export function setThreshold(value: number): void {
  log.info({ oldValue: threshold, newValue: value }, 'Threshold updated');
  threshold = value;
}

export function setMaxPositionSize(value: number): void {
  log.info({ oldValue: maxPositionSize, newValue: value }, 'Max position size updated');
  maxPositionSize = value;
}

export function setMaxOpenPositions(value: number): void {
  log.info({ oldValue: maxOpenPositions, newValue: value }, 'Max open positions updated');
  maxOpenPositions = value;
}

// Timeframe getters/setters
export function getMarketTimeframe(): '1h' | '4h' | 'daily' {
  return marketTimeframe;
}

export function setMarketTimeframe(value: '1h' | '4h' | 'daily'): void {
  log.info({ oldValue: marketTimeframe, newValue: value }, 'Market timeframe updated');
  marketTimeframe = value;
}

// Get fee rate for current timeframe (all 0% for hourly/4h/daily!)
export function getCurrentFeeRate(): number {
  const feeRates: Record<string, number> = {
    '1h': 0.00,    // FREE
    '4h': 0.00,    // FREE
    'daily': 0.00, // FREE
  };
  return feeRates[marketTimeframe] ?? 0.00;
}

// Get all current config
export function getRuntimeConfig(): { threshold: number; maxPositionSize: number; maxOpenPositions: number; timeframe: string; feeRate: number } {
  return { threshold, maxPositionSize, maxOpenPositions, timeframe: marketTimeframe, feeRate: getCurrentFeeRate() };
}
