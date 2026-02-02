/**
 * Timing metrics for trade execution latency
 */

import { createChildLogger } from './logger.js';

const log = createChildLogger('timing');

interface TimingRecord {
  timestamp: number;
  event: string;
  durationMs: number;
  market?: string;
}

// Keep last 100 timing records
const timingHistory: TimingRecord[] = [];
const MAX_HISTORY = 100;

// Aggregated stats
let stats = {
  dipDetectionCount: 0,
  dipDetectionTotalMs: 0,
  tradeExecutionCount: 0,
  tradeExecutionTotalMs: 0,
  wsMessageCount: 0,
  wsMessageTotalMs: 0,
};

export function recordTiming(event: string, durationMs: number, market?: string): void {
  const record: TimingRecord = {
    timestamp: Date.now(),
    event,
    durationMs,
    market,
  };

  timingHistory.push(record);
  if (timingHistory.length > MAX_HISTORY) {
    timingHistory.shift();
  }

  // Update aggregated stats
  switch (event) {
    case 'dip_detection':
      stats.dipDetectionCount++;
      stats.dipDetectionTotalMs += durationMs;
      break;
    case 'trade_execution':
      stats.tradeExecutionCount++;
      stats.tradeExecutionTotalMs += durationMs;
      break;
    case 'ws_message':
      stats.wsMessageCount++;
      stats.wsMessageTotalMs += durationMs;
      break;
  }

  // Log slow operations
  if (durationMs > 100) {
    log.warn({ event, durationMs, market }, '⏱️ Slow operation detected');
  }
}

export function getTimingStats(): {
  dipDetection: { count: number; avgMs: number };
  tradeExecution: { count: number; avgMs: number };
  wsMessage: { count: number; avgMs: number };
  recentSlow: TimingRecord[];
} {
  const recentSlow = timingHistory
    .filter(r => r.durationMs > 50)
    .slice(-10);

  return {
    dipDetection: {
      count: stats.dipDetectionCount,
      avgMs: stats.dipDetectionCount > 0
        ? stats.dipDetectionTotalMs / stats.dipDetectionCount
        : 0,
    },
    tradeExecution: {
      count: stats.tradeExecutionCount,
      avgMs: stats.tradeExecutionCount > 0
        ? stats.tradeExecutionTotalMs / stats.tradeExecutionCount
        : 0,
    },
    wsMessage: {
      count: stats.wsMessageCount,
      avgMs: stats.wsMessageCount > 0
        ? stats.wsMessageTotalMs / stats.wsMessageCount
        : 0,
    },
    recentSlow,
  };
}

export function resetTimingStats(): void {
  stats = {
    dipDetectionCount: 0,
    dipDetectionTotalMs: 0,
    tradeExecutionCount: 0,
    tradeExecutionTotalMs: 0,
    wsMessageCount: 0,
    wsMessageTotalMs: 0,
  };
  timingHistory.length = 0;
}

// Helper to measure execution time
export function measureTime<T>(fn: () => T, event: string, market?: string): T {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  recordTiming(event, duration, market);
  return result;
}

export async function measureTimeAsync<T>(fn: () => Promise<T>, event: string, market?: string): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  recordTiming(event, duration, market);
  return result;
}
