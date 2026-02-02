import { config } from './config.js';
import { createChildLogger } from './logger.js';
import { initDb, closeDb, logEvent, getStats } from './db.js';
import {
  initNotifier,
  notifyStartup,
  notifyDipDetected,
  notifyTradeExecuted,
  notifyTradeFailed,
  notifyPositionResolved,
  notifyError,
  notifyDailyStats,
  notifyShutdown,
  notify15MinSummary,
  notifyDailySummary,
  notifyWalletDeposit,
  isLiveTradingEnabled,
  type PriceSummary,
  type SessionStats,
} from './notifier.js';
import { startWalletMonitor, stopWalletMonitor, setOnDepositCallback } from './wallet-monitor.js';
import { startResolutionTracker, stopResolutionTracker } from './resolution-tracker.js';
import { getPositionsLast15Min, getTodayPositions, getStatsByMarket } from './db.js';
import { initExecutor, executeDipTrade, isReady as isExecutorReady } from './executor.js';
import {
  initPositionManager,
  canOpenPosition,
  hasOpenPositionForMarket,
  createPosition,
  getAllOpenPositions,
  getPositionsSummary,
} from './position-manager.js';
import {
  initMarketData,
  startOrderbookStream,
  onOrderbookUpdate,
  getMarketTokens,
  getOrderbook,
  stopOrderbookStreams,
  getAndResetMessageCounts,
} from './market-data.js';
import {
  detectDip,
  markTradePending,
  markTradeExecuted,
  clearTradePending,
  calculatePositionSizeWithLiquidity,
  updateBalance,
  getCurrentBalance,
} from './dip-detector.js';
import { handleStrategyB, getStrategyBStats, getActiveCycles } from './strategy-b.js';
import type { Orderbook, DipOpportunity } from './types.js';

const log = createChildLogger('main');

let isRunning = false;
let statsInterval: NodeJS.Timeout | null = null;
let priceLogInterval: NodeJS.Timeout | null = null;
let summaryTimeout: NodeJS.Timeout | null = null;
let dailySummaryInterval: NodeJS.Timeout | null = null;
let tradesThisPeriod = 0;
let volumeThisPeriod = 0;

/**
 * Calculate milliseconds until next 15-minute clock boundary
 * Boundaries: :00, :15, :30, :45
 */
function getMsUntilNext15MinBoundary(): { ms: number; nextTime: Date } {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();

  // Find next 15-minute boundary
  const minutesUntilBoundary = 15 - (minutes % 15);
  const msUntilBoundary = (minutesUntilBoundary * 60 * 1000) - (seconds * 1000) - milliseconds;

  const nextTime = new Date(now.getTime() + msUntilBoundary);
  return { ms: msUntilBoundary, nextTime };
}

async function main(): Promise<void> {
  log.info('Starting Polymarket Dip Arbitrage Bot');
  log.info({
    markets: config.markets.map((m) => m.symbol),
    threshold: config.trading.threshold,
    maxPosition: config.trading.maxPositionSize,
    maxOpen: config.trading.maxOpenPositions,
  });

  try {
    // Initialize all services
    await initDb();
    initNotifier();
    await initExecutor();
    initPositionManager();
    await initMarketData();

    // Start wallet monitor for deposit notifications
    setOnDepositCallback(notifyWalletDeposit);
    await startWalletMonitor(60000); // Check every 60 seconds

    // Start listening to orderbook updates
    onOrderbookUpdate(handleOrderbookUpdate);
    await startOrderbookStream();

    // Start resolution tracker
    startResolutionTracker();

    isRunning = true;

    // Send startup notification
    await notifyStartup();

    // Schedule daily stats
    statsInterval = setInterval(
      async () => {
        const stats = getStats();
        await notifyDailyStats(stats);
      },
      24 * 60 * 60 * 1000 // Every 24 hours
    );

    // Log prices every 30 seconds
    priceLogInterval = setInterval(() => {
      const priceData: Record<string, { up: number; down: number; total: number }> = {};
      for (const market of config.markets) {
        const ob = getOrderbook(market.symbol);
        if (ob && ob.UP.asks.length > 0 && ob.DOWN.asks.length > 0) {
          const up = ob.UP.asks[0].price;
          const down = ob.DOWN.asks[0].price;
          priceData[market.symbol] = { up, down, total: up + down };
        }
      }
      if (Object.keys(priceData).length > 0) {
        const summary = Object.entries(priceData)
          .map(([sym, p]) => `${sym}:${p.total.toFixed(3)}`)
          .join(' | ');
        log.info({ prices: priceData }, `📊 ${summary}`);
      }
    }, 30000);

    // Send 15-minute summary to Telegram (aligned to clock :00, :15, :30, :45)
    async function sendAndScheduleNextSummary(): Promise<void> {
      // Send summary
      const prices: PriceSummary[] = [];
      for (const market of config.markets) {
        const ob = getOrderbook(market.symbol);
        if (ob && ob.UP.asks.length > 0 && ob.DOWN.asks.length > 0) {
          prices.push({
            symbol: market.symbol,
            up: ob.UP.asks[0].price,
            down: ob.DOWN.asks[0].price,
            total: ob.UP.asks[0].price + ob.DOWN.asks[0].price,
          });
        }
      }

      // Get session stats from recent positions
      const recentPositions = getPositionsLast15Min();
      const resolvedPositions = recentPositions.filter(p => p.status === 'resolved');

      // Get WebSocket message counts for this period
      const wsCounts = getAndResetMessageCounts();

      const sessionStats: SessionStats = {
        tradesExecuted: tradesThisPeriod,
        tradesResolved: resolvedPositions.length,
        totalVolume: volumeThisPeriod,
        totalProfit: resolvedPositions.reduce((sum, p) => sum + (p.actualProfit ?? 0), 0),
        totalFees: resolvedPositions.reduce((sum, p) => sum + (p.fees ?? 0), 0),
        wsMessages: wsCounts.messages,
        wsUpdates: wsCounts.updates,
      };

      await notify15MinSummary(prices, sessionStats, config.paperTrading);

      // Reset counters for next period
      tradesThisPeriod = 0;
      volumeThisPeriod = 0;

      // Schedule next summary aligned to clock
      if (isRunning) {
        const { ms, nextTime } = getMsUntilNext15MinBoundary();
        log.info({ nextSummary: nextTime.toISOString(), msUntil: ms }, '⏰ Next summary scheduled');
        summaryTimeout = setTimeout(sendAndScheduleNextSummary, ms);
      }
    }

    // Schedule first summary at next 15-minute boundary
    const { ms: initialDelay, nextTime } = getMsUntilNext15MinBoundary();
    log.info({ firstSummary: nextTime.toISOString(), msUntil: initialDelay }, '⏰ First summary scheduled (clock-aligned)');
    summaryTimeout = setTimeout(sendAndScheduleNextSummary, initialDelay);

    // Send daily summary at midnight (or every 24h from start)
    dailySummaryInterval = setInterval(async () => {
      const todayPositions = getTodayPositions();
      const resolvedToday = todayPositions.filter(p => p.status === 'resolved');
      const marketStats = getStatsByMarket();

      const totalVolume = todayPositions.reduce((sum, p) => sum + p.totalCost, 0);
      const netProfit = resolvedToday.reduce((sum, p) => sum + (p.actualProfit ?? 0) - (p.fees ?? 0), 0);

      await notifyDailySummary({
        totalTrades: todayPositions.length,
        resolvedTrades: resolvedToday.length,
        totalVolume,
        netProfit,
        avgROI: totalVolume > 0 ? (netProfit / totalVolume) * 100 : 0,
        byMarket: marketStats.map(m => ({
          market: m.market,
          trades: m.totalTrades,
          profit: m.netProfit,
        })),
      });
    }, 24 * 60 * 60 * 1000); // Every 24 hours

    // Handle graceful shutdown
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    log.info('Bot started successfully, monitoring for dips...');

    // Keep the process running
    await new Promise<void>((resolve) => {
      process.on('beforeExit', resolve);
    });
  } catch (error) {
    log.fatal({ error }, 'Fatal error during startup');
    await notifyError('startup', error);
    process.exit(1);
  }
}

async function handleOrderbookUpdate(orderbook: Orderbook): Promise<void> {
  if (!isRunning || !isExecutorReady()) return;

  // Run Strategy B in parallel (if enabled)
  if (config.strategyB.enabled) {
    try {
      await handleStrategyB(orderbook);
    } catch (error) {
      log.error({ error, market: orderbook.market }, 'Strategy B error');
    }
  }

  // Strategy A logic below
  try {
    // Check if we can open more positions
    if (!canOpenPosition()) {
      log.debug('Max open positions reached, skipping');
      return;
    }

    // Check if we already have a position for this market
    if (hasOpenPositionForMarket(orderbook.market)) {
      log.debug({ market: orderbook.market }, 'Already have position for market, skipping');
      return;
    }

    // Detect dip opportunity
    const detection = detectDip(orderbook);

    if (!detection.shouldTrade) {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.01) {
        log.debug({ market: orderbook.market, reason: detection.skipReason }, 'No trade');
      }
      return;
    }

    const opportunity = detection.opportunity!;

    // ALWAYS notify dip detection (even if we can't trade it)
    await notifyDipDetected(opportunity);

    // Calculate position size with deep liquidity analysis
    const sizing = calculatePositionSizeWithLiquidity(opportunity, orderbook);

    // Check if trade is viable after liquidity analysis
    if (!sizing.viable) {
      log.warn({
        market: orderbook.market,
        reason: sizing.reason,
        slippage: (sizing.estimatedSlippage * 100).toFixed(2) + '%',
      }, 'Trade not viable due to liquidity constraints');
      // Notify that we detected but couldn't trade
      await notifyTradeFailed(opportunity.market, sizing.reason ?? 'Liquidity constraints');
      return;
    }

    // Get market tokens for execution
    const tokens = getMarketTokens(opportunity.market);
    if (!tokens) {
      log.error({ market: opportunity.market }, 'Market tokens not found');
      return;
    }

    log.info(
      {
        market: opportunity.market,
        idealCost: opportunity.totalCost.toFixed(3),
        adjustedCost: sizing.totalCost.toFixed(3),
        idealProfit: opportunity.expectedProfit.toFixed(3),
        adjustedProfit: sizing.adjustedProfit.toFixed(3),
        slippage: (sizing.estimatedSlippage * 100).toFixed(2) + '%',
        sizeUp: sizing.sizeUp.toFixed(2),
        sizeDown: sizing.sizeDown.toFixed(2),
      },
      '🎯 Executing dip trade (liquidity checked)'
    );

    // 🔒 Mark trade as pending BEFORE execution to prevent duplicates
    markTradePending(opportunity.market);

    // Execute the trade
    const result = await executeDipTrade(
      opportunity,
      sizing.sizeUp,
      sizing.sizeDown,
      tokens.tokenIdUp,
      tokens.tokenIdDown
    );

    if (result.success && result.position) {
      // Create and track position with liquidity data
      const position = createPosition(opportunity, result.position, {
        estimatedSlippage: sizing.estimatedSlippage,
      });

      // Mark trade executed for cooldown
      markTradeExecuted(opportunity.market);

      // Increment period counters for 15-min summary
      tradesThisPeriod++;
      volumeThisPeriod += position.totalCost;

      // Log event
      logEvent('trade_executed', {
        positionId: position.id,
        market: position.market,
        totalCost: position.totalCost,
        expectedProfit: position.expectedProfit,
      });

      // Notify success
      await notifyTradeExecuted(position);
    } else {
      // 🔓 Clear pending state on failure
      clearTradePending(opportunity.market);

      // Log failure
      logEvent('trade_failed', {
        market: opportunity.market,
        error: result.error,
      });

      // Notify failure
      await notifyTradeFailed(opportunity.market, result.error ?? 'Unknown error');
    }
  } catch (error) {
    log.error({ error, market: orderbook.market }, 'Error handling orderbook update');
    await notifyError(`orderbook_${orderbook.market}`, error);
  }
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutdown signal received');

  isRunning = false;

  if (statsInterval) {
    clearInterval(statsInterval);
  }
  if (priceLogInterval) {
    clearInterval(priceLogInterval);
  }
  if (summaryTimeout) {
    clearTimeout(summaryTimeout);
  }
  if (dailySummaryInterval) {
    clearInterval(dailySummaryInterval);
  }

  // Stop resolution tracker
  stopResolutionTracker();

  // Stop wallet monitor
  stopWalletMonitor();

  // Stop orderbook streams
  stopOrderbookStreams();

  // Get final stats
  const stats = getStats();
  log.info({ stats }, 'Final stats');

  // Check for open positions
  const openPositions = getAllOpenPositions();
  if (openPositions.length > 0) {
    log.warn({ count: openPositions.length }, 'Shutting down with open positions!');
    await notifyError(
      'shutdown',
      `Shutting down with ${openPositions.length} open positions. They will resolve automatically.`
    );
  }

  // Send shutdown notification with stats
  await notifyShutdown(`${signal} - Net profit: $${stats.netProfit.toFixed(2)}`);

  // Close database
  closeDb();

  log.info('Shutdown complete');
  process.exit(0);
}

// Run the bot
main().catch((error) => {
  log.fatal({ error }, 'Unhandled error');
  process.exit(1);
});
