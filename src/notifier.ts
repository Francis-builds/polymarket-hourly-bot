import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { createChildLogger } from './logger.js';
import {
  getTodayPositions,
  getDailyStats,
  getStatsByMarket,
  getRecentPositions,
  getOpenPositions,
  getOrderbookSnapshots,
} from './db.js';
import { getStrategyBStats, getActiveCycles } from './strategy-b.js';
import { getTimingStats } from './timing.js';
import { getCurrentBalance } from './dip-detector.js';
import { getLastKnownBalance } from './wallet-monitor.js';
import { getPolymarketBalance, getPortfolio, withdrawFromPolymarket, isPolymarketApiConfigured, getApiStatus, type PortfolioSummary } from './polymarket-api.js';
import type { DipOpportunity, Position, BotStats } from './types.js';

// Cached Polymarket balance (updated periodically)
let cachedPolymarketBalance: number | null = null;
let lastPolymarketBalanceCheck = 0;
const BALANCE_CACHE_MS = 30000; // 30 seconds

const log = createChildLogger('notifier');

let bot: TelegramBot | null = null;

// Mutable trading mode (can be changed at runtime)
let isLiveTrading = !config.paperTrading;

// Import runtime config (mutable via Telegram commands)
import {
  getThreshold,
  getMaxPositionSize,
  getMaxOpenPositions,
  getMaxTotalCost,
  setThreshold,
  setMaxPositionSize,
  setMaxOpenPositions,
  setMaxTotalCost,
  getRuntimeConfig,
} from './runtime-config.js';

export function isLiveTradingEnabled(): boolean {
  return isLiveTrading;
}

export function setLiveTrading(enabled: boolean): void {
  isLiveTrading = enabled;
  log.info({ liveTrading: enabled }, enabled ? '🔴 LIVE TRADING ENABLED' : '📝 PAPER TRADING ENABLED');
}

export function initNotifier(): void {
  // Skip Telegram initialization if no token (paper mode)
  if (!config.telegram.botToken || !config.telegram.chatId) {
    log.info('Telegram not configured - notifications will be logged to console only');
    return;
  }

  // Enable polling to receive commands
  bot = new TelegramBot(config.telegram.botToken, { polling: true });
  log.info('Telegram notifier initialized with polling');

  // Register command handlers
  setupCommands();
}

function setupCommands(): void {
  if (!bot) return;

  bot.onText(/\/stats/, handleStatsCommand);
  bot.onText(/\/today/, handleTodayCommand);
  bot.onText(/\/markets/, handleMarketsCommand);
  bot.onText(/\/open/, handleOpenCommand);
  bot.onText(/\/compare/, handleCompareCommand);
  bot.onText(/\/timing/, handleTimingCommand);
  bot.onText(/\/balance/, handleBalanceCommand);
  bot.onText(/\/liquidity/, handleLiquidityCommand);
  bot.onText(/\/golive/, handleGoLiveCommand);
  bot.onText(/\/gopaper/, handleGoPaperCommand);
  bot.onText(/\/wallet/, handleWalletCommand);
  bot.onText(/\/portfolio/, handlePortfolioCommand);
  bot.onText(/\/claim/, handleClaimCommand);
  bot.onText(/\/withdraw(?:\s+(\d+(?:\.\d+)?))?/, handleWithdrawCommand);
  bot.onText(/\/threshold(?:\s+(\d+(?:\.\d+)?))?/, handleThresholdCommand);
  bot.onText(/\/maxposition(?:\s+(\d+(?:\.\d+)?))?/, handleMaxPositionCommand);
  bot.onText(/\/maxopen(?:\s+(\d+))?/, handleMaxOpenCommand);
  bot.onText(/\/maxcost(?:\s+(\d+(?:\.\d+)?))?/, handleMaxCostCommand);
  bot.onText(/\/config/, handleConfigCommand);
  bot.onText(/\/help/, handleHelpCommand);

  log.info('Telegram commands registered');
}

async function handleStatsCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const dailyStats = getDailyStats(7);

  let statsText = '📊 <b>STATS ÚLTIMOS 7 DÍAS</b>\n\n';
  statsText += '<code>Fecha      | Res | Profit  | ROI\n';
  statsText += '───────────────────────────────────\n';

  let totalResolved = 0;
  let totalProfit = 0;
  let totalVolume = 0;

  for (const day of dailyStats) {
    totalResolved += day.resolvedTrades;
    totalProfit += day.netProfit;
    totalVolume += day.resolvedVolume;

    statsText += `${day.date} | ${day.resolvedTrades.toString().padStart(3)} | $${day.netProfit.toFixed(2).padStart(6)} | ${day.avgROI.toFixed(1)}%\n`;
  }

  statsText += '───────────────────────────────────\n';
  const totalROI = totalVolume > 0 ? (totalProfit / totalVolume) * 100 : 0;
  statsText += `TOTAL      | ${totalResolved.toString().padStart(3)} | $${totalProfit.toFixed(2).padStart(6)} | ${totalROI.toFixed(1)}%</code>`;

  await bot?.sendMessage(msg.chat.id, statsText, { parse_mode: 'HTML' });
}

async function handleTodayCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const positions = getTodayPositions();
  const resolved = positions.filter(p => p.status === 'resolved');
  const open = positions.filter(p => p.status === 'open');

  const resolvedVolume = resolved.reduce((sum, p) => sum + p.totalCost, 0);
  const openVolume = open.reduce((sum, p) => sum + p.totalCost, 0);
  const totalProfit = resolved.reduce((sum, p) => sum + (p.actualProfit ?? 0), 0);
  const totalFees = resolved.reduce((sum, p) => sum + (p.fees ?? 0), 0);
  const netProfit = totalProfit - totalFees;
  const roi = resolvedVolume > 0 ? (netProfit / resolvedVolume) * 100 : 0;

  const profitEmoji = netProfit >= 0 ? '💰' : '📉';

  const msg_text = `
📅 <b>STATS DE HOY</b>

<b>Trades:</b>
  Total: ${positions.length}
  Resueltos: ${resolved.length}
  Abiertos: ${open.length}

<b>Volumen:</b>
  Resuelto: $${resolvedVolume.toFixed(2)}
  En juego: $${openVolume.toFixed(2)}

<b>Resultado (solo resueltos):</b>
  Profit bruto: $${totalProfit.toFixed(2)}
  Fees: $${totalFees.toFixed(2)}
  ${profitEmoji} Neto: <b>$${netProfit.toFixed(2)}</b>
  ROI: ${roi.toFixed(2)}%
  `.trim();

  await bot?.sendMessage(msg.chat.id, msg_text, { parse_mode: 'HTML' });
}

async function handleMarketsCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const stats = getStatsByMarket();

  let text = '📈 <b>STATS POR MERCADO</b>\n\n';
  text += '<code>Asset | Res | Profit  | ROI\n';
  text += '────────────────────────────────\n';

  for (const m of stats) {
    const emoji = m.netProfit >= 0 ? '🟢' : '🔴';
    text += `${emoji} ${m.market.padEnd(4)} | ${m.resolvedTrades.toString().padStart(3)} | $${m.netProfit.toFixed(2).padStart(6)} | ${m.avgROI.toFixed(1)}%\n`;
  }
  text += '</code>';

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleOpenCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const open = getOpenPositions();

  if (open.length === 0) {
    await bot?.sendMessage(msg.chat.id, '✅ No hay posiciones abiertas');
    return;
  }

  let text = `⏳ <b>${open.length} POSICIONES ABIERTAS</b>\n\n`;

  for (const p of open) {
    const age = Math.floor((Date.now() - p.openedAt) / 60000);
    text += `<b>${p.market}</b>: $${p.totalCost.toFixed(2)} (${age}min)\n`;
  }

  const totalInvested = open.reduce((sum, p) => sum + p.totalCost, 0);
  text += `\n💵 Total en juego: $${totalInvested.toFixed(2)}`;

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleCompareCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  // Strategy A stats (from DB - only resolved, excluding STB_ positions)
  const allPositions = getTodayPositions();
  const positionsA = allPositions.filter(p => !p.id.startsWith('STB_') && !p.id.startsWith('stb_'));
  const resolvedA = positionsA.filter(p => p.status === 'resolved');
  const openA = positionsA.filter(p => p.status === 'open');
  const volumeA = resolvedA.reduce((sum, p) => sum + p.totalCost, 0);
  const profitA = resolvedA.reduce((sum, p) => sum + (p.actualProfit ?? 0) - (p.fees ?? 0), 0);
  const roiA = volumeA > 0 ? (profitA / volumeA) * 100 : 0;

  // Strategy B stats
  const statsB = getStrategyBStats();
  const activeCyclesB = getActiveCycles();

  // Strategy B from DB (positions starting with STB_)
  const positionsB = allPositions.filter(p => p.id.startsWith('STB_') || p.id.startsWith('stb_'));
  const resolvedB = positionsB.filter(p => p.status === 'resolved');
  const volumeB = resolvedB.reduce((sum, p) => sum + p.totalCost, 0);
  const profitB = resolvedB.reduce((sum, p) => sum + (p.actualProfit ?? 0) - (p.fees ?? 0), 0);
  const roiB = volumeB > 0 ? (profitB / volumeB) * 100 : 0;

  const winnerA = profitA > profitB;
  const winnerB = profitB > profitA;

  const text = `
⚔️ <b>STRATEGY A vs B</b> (hoy)

<code>┌────────────┬──────────┬──────────┐
│ Métrica    │ 🅰️ A      │ 🅱️ B      │
├────────────┼──────────┼──────────┤
│ Resueltos  │ ${resolvedA.length.toString().padStart(8)} │ ${resolvedB.length.toString().padStart(8)} │
│ Abiertos   │ ${openA.length.toString().padStart(8)} │ ${activeCyclesB.length.toString().padStart(8)} │
│ Volumen    │ $${volumeA.toFixed(0).padStart(6)} │ $${volumeB.toFixed(0).padStart(6)} │
│ Profit     │ $${profitA.toFixed(2).padStart(6)} │ $${profitB.toFixed(2).padStart(6)} │
│ ROI        │ ${roiA.toFixed(1).padStart(6)}% │ ${roiB.toFixed(1).padStart(6)}% │
└────────────┴──────────┴──────────┘</code>

🅱️ Leg1: ${statsB.leg1Triggered} | Leg2: ${statsB.leg2Triggered} | Abandonados: ${statsB.cyclesAbandoned}

${winnerA || winnerB ? `👑 <b>Ganador: Strategy ${winnerA ? 'A' : 'B'}</b> (+$${Math.abs(profitA - profitB).toFixed(2)})` : '🤝 Empate'}
  `.trim();

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleTimingCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const timing = getTimingStats();

  const text = `
⏱️ <b>TIMING STATS</b>

<code>┌────────────────┬───────┬─────────┐
│ Operación      │ Count │ Avg ms  │
├────────────────┼───────┼─────────┤
│ WS Message     │ ${timing.wsMessage.count.toString().padStart(5)} │ ${timing.wsMessage.avgMs.toFixed(1).padStart(7)} │
│ Dip Detection  │ ${timing.dipDetection.count.toString().padStart(5)} │ ${timing.dipDetection.avgMs.toFixed(1).padStart(7)} │
│ Trade Exec     │ ${timing.tradeExecution.count.toString().padStart(5)} │ ${timing.tradeExecution.avgMs.toFixed(1).padStart(7)} │
└────────────────┴───────┴─────────┘</code>

${timing.recentSlow.length > 0 ? `<b>Últimas operaciones lentas (>50ms):</b>\n${timing.recentSlow.map(r => `• ${r.event}: ${r.durationMs.toFixed(0)}ms`).join('\n')}` : '✅ Sin operaciones lentas recientes'}
  `.trim();

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleBalanceCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const balance = getCurrentBalance();
  const initialBalance = config.trading.initialBalance;
  const pnl = balance - initialBalance;
  const pnlPct = (pnl / initialBalance * 100);
  const emoji = pnl >= 0 ? '📈' : '📉';

  const riskPerTrade = config.trading.riskPerTrade * 100;
  const nextTradeSize = balance * config.trading.riskPerTrade;

  const text = `
💰 <b>BALANCE</b>

<code>┌─────────────────┬───────────┐
│ Balance inicial │ $${initialBalance.toFixed(2).padStart(8)} │
│ Balance actual  │ $${balance.toFixed(2).padStart(8)} │
├─────────────────┼───────────┤
│ PnL             │ $${pnl.toFixed(2).padStart(8)} │
│ PnL %           │ ${pnlPct.toFixed(2).padStart(7)}% │
└─────────────────┴───────────┘</code>

${emoji} ${pnl >= 0 ? 'Ganando' : 'Perdiendo'} ${Math.abs(pnlPct).toFixed(1)}%

<b>Próximo trade:</b>
Risk: ${riskPerTrade}% = $${nextTradeSize.toFixed(2)}
  `.trim();

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleLiquidityCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  try {
    const snapshots = getOrderbookSnapshots(10);

    if (snapshots.length === 0) {
      await bot?.sendMessage(msg.chat.id, '📊 No hay snapshots de liquidez todavía.\n\nSe guardan cuando se detectan dips.');
      return;
    }

    let text = `📊 <b>LIQUIDEZ REAL</b> (últimos ${snapshots.length} dips)\n\n`;
    text += '<code>Market | Entry  | Liq UP | Liq DOWN\n';
    text += '───────────────────────────────────\n';

    for (const snap of snapshots) {
      const liqUp = snap.liquidityUp5pct ?? 0;
      const liqDown = snap.liquidityDown5pct ?? 0;
      text += `${snap.market.padEnd(6)} | $${snap.totalCost.toFixed(2).padStart(5)} | ${liqUp.toFixed(0).padStart(6)} | ${liqDown.toFixed(0).padStart(8)}\n`;
    }
    text += '</code>\n\n';

    // Calculate averages
    const avgLiqUp = snapshots.reduce((sum, s) => sum + (s.liquidityUp5pct ?? 0), 0) / snapshots.length;
    const avgLiqDown = snapshots.reduce((sum, s) => sum + (s.liquidityDown5pct ?? 0), 0) / snapshots.length;
    const avgEntry = snapshots.reduce((sum, s) => sum + s.totalCost, 0) / snapshots.length;

    text += `<b>Promedios:</b>\n`;
    text += `Entry: $${avgEntry.toFixed(3)} | Liq UP: ${avgLiqUp.toFixed(0)} | Liq DOWN: ${avgLiqDown.toFixed(0)}`;

    await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (error) {
    log.error({ error }, 'Error in liquidity command');
    await bot?.sendMessage(msg.chat.id, '❌ Error obteniendo datos de liquidez');
  }
}

async function handleGoLiveCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  // Check Polymarket balance first, then wallet
  const polymarketBalance = await getCachedPolymarketBalance();
  const walletBalance = getLastKnownBalance();
  const totalBalance = (polymarketBalance ?? 0) + (walletBalance ?? 0);
  const tradingBalance = polymarketBalance ?? 0; // Only Polymarket balance can be used for trading

  if (tradingBalance < 10) {
    await bot?.sendMessage(
      msg.chat.id,
      `⚠️ <b>No se puede activar LIVE TRADING</b>\n\n` +
      `Balance en Polymarket: $${polymarketBalance?.toFixed(2) ?? 'desconocido'}\n` +
      `Balance en Wallet: $${walletBalance?.toFixed(2) ?? '0.00'}\n` +
      `Mínimo requerido en Polymarket: $10 USDC\n\n` +
      `Depositá USDC en Polymarket desde tu wallet.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  setLiveTrading(true);

  await bot?.sendMessage(
    msg.chat.id,
    `🔴 <b>LIVE TRADING ACTIVADO</b>\n\n` +
    `💰 Balance Polymarket: $${tradingBalance.toFixed(2)} USDC\n` +
    `💼 Balance Wallet: $${walletBalance?.toFixed(2) ?? '0.00'} USDC\n` +
    `⚙️ Threshold: ${config.trading.threshold}\n` +
    `📊 Max position: $${config.trading.maxPositionSize}\n\n` +
    `⚠️ Las próximas operaciones serán REALES.\n` +
    `Usa /gopaper para volver a paper trading.`,
    { parse_mode: 'HTML' }
  );
}

async function handleGoPaperCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  setLiveTrading(false);

  await bot?.sendMessage(
    msg.chat.id,
    `📝 <b>PAPER TRADING ACTIVADO</b>\n\n` +
    `Las operaciones se simularán sin usar fondos reales.\n` +
    `Usa /golive para activar trading real.`,
    { parse_mode: 'HTML' }
  );
}

async function getCachedPolymarketBalance(): Promise<number | null> {
  const now = Date.now();
  if (cachedPolymarketBalance !== null && now - lastPolymarketBalanceCheck < BALANCE_CACHE_MS) {
    return cachedPolymarketBalance;
  }

  cachedPolymarketBalance = await getPolymarketBalance();
  lastPolymarketBalanceCheck = now;
  return cachedPolymarketBalance;
}

async function handleWalletCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  await bot?.sendMessage(msg.chat.id, '⏳ Consultando portfolio...', { parse_mode: 'HTML' });

  const walletBalance = getLastKnownBalance();
  const portfolio = await getPortfolio();
  const address = process.env.POLYMARKET_ADDRESS || 'No configurado';
  const mode = isLiveTrading ? '🔴 LIVE' : '📝 PAPER';

  let text = `💼 <b>PORTFOLIO</b>\n\n`;

  if (portfolio) {
    const pnlEmoji = portfolio.unrealizedPnl >= 0 ? '📈' : '📉';

    text += `<code>┌──────────────────────────────┐\n`;
    text += `│ 💵 Cash disponible │ $${portfolio.cashAvailable.toFixed(2).padStart(8)} │\n`;
    text += `│ 📊 Posiciones      │ $${portfolio.positionsValue.toFixed(2).padStart(8)} │\n`;
    if (portfolio.unclaimedProceeds > 0) {
      text += `│ 🎁 Sin reclamar   │ $${portfolio.unclaimedProceeds.toFixed(2).padStart(8)} │\n`;
    }
    text += `├──────────────────────────────┤\n`;
    text += `│ 💰 <b>POLYMARKET</b>    │ $${portfolio.totalPortfolio.toFixed(2).padStart(8)} │\n`;
    text += `│ 💼 Wallet Polygon  │ $${(walletBalance ?? 0).toFixed(2).padStart(8)} │\n`;
    text += `├──────────────────────────────┤\n`;
    const grandTotal = portfolio.totalPortfolio + (walletBalance ?? 0);
    text += `│ 🏦 <b>TOTAL</b>          │ $${grandTotal.toFixed(2).padStart(8)} │\n`;
    text += `└──────────────────────────────┘</code>\n\n`;

    if (portfolio.unrealizedPnl !== 0) {
      text += `${pnlEmoji} PnL no realizado: $${portfolio.unrealizedPnl.toFixed(2)}\n`;
    }

    if (portfolio.positions.length > 0) {
      text += `\n📊 <b>${portfolio.positions.length} posiciones abiertas</b>\n`;
      text += `/portfolio para detalle\n`;
    }

    if (portfolio.unclaimedProceeds > 0) {
      text += `\n🎁 <b>Hay $${portfolio.unclaimedProceeds.toFixed(2)} sin reclamar!</b>\n`;
      text += `/claim para reclamar\n`;
    }
  } else {
    text += `⚠️ Error consultando portfolio\n`;
    text += `💼 <b>Wallet:</b> $${walletBalance?.toFixed(2) ?? '0.00'} USDC\n`;
  }

  text += `\n📍 <code>${address}</code>\n`;
  text += `🎮 Modo: ${mode}`;

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handlePortfolioCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  await bot?.sendMessage(msg.chat.id, '⏳ Consultando posiciones...', { parse_mode: 'HTML' });

  const portfolio = await getPortfolio();

  if (!portfolio) {
    await bot?.sendMessage(msg.chat.id, '⚠️ Error consultando portfolio', { parse_mode: 'HTML' });
    return;
  }

  let text = `📊 <b>POSICIONES ABIERTAS</b>\n\n`;

  if (portfolio.positions.length === 0) {
    text += `No hay posiciones abiertas.\n`;
    text += `\n💵 Cash disponible: $${portfolio.cashAvailable.toFixed(2)}`;
  } else {
    for (const pos of portfolio.positions.slice(0, 10)) {
      const pnlEmoji = pos.pnl >= 0 ? '🟢' : '🔴';
      const shortQuestion = pos.question?.slice(0, 30) || pos.market.slice(0, 10);

      text += `${pnlEmoji} <b>${shortQuestion}...</b>\n`;
      text += `   ${pos.outcome}: ${pos.size.toFixed(0)} @ $${pos.avgPrice.toFixed(3)}\n`;
      text += `   Valor: $${pos.currentValue.toFixed(2)} (${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)})\n\n`;
    }

    if (portfolio.positions.length > 10) {
      text += `<i>... y ${portfolio.positions.length - 10} posiciones más</i>\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━\n`;
    text += `💵 Cash: $${portfolio.cashAvailable.toFixed(2)}\n`;
    text += `📊 Posiciones: $${portfolio.positionsValue.toFixed(2)}\n`;
    text += `💰 Total: $${portfolio.totalPortfolio.toFixed(2)}`;
  }

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function handleClaimCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  await bot?.sendMessage(msg.chat.id, '⏳ Buscando proceeds sin reclamar...', { parse_mode: 'HTML' });

  const portfolio = await getPortfolio();

  if (!portfolio) {
    await bot?.sendMessage(msg.chat.id, '⚠️ Error consultando portfolio', { parse_mode: 'HTML' });
    return;
  }

  if (portfolio.unclaimedProceeds <= 0) {
    await bot?.sendMessage(
      msg.chat.id,
      `✅ No hay proceeds sin reclamar.\n\n💵 Cash disponible: $${portfolio.cashAvailable.toFixed(2)}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await bot?.sendMessage(
    msg.chat.id,
    `🎁 <b>PROCEEDS SIN RECLAMAR</b>\n\n` +
    `Monto: <b>$${portfolio.unclaimedProceeds.toFixed(2)}</b>\n\n` +
    `⚠️ <b>Claim automático no disponible aún.</b>\n\n` +
    `Para reclamar manualmente:\n` +
    `1. Ve a polymarket.com/portfolio\n` +
    `2. Click en "Claim" en las posiciones resueltas\n\n` +
    `<i>El claim automático requiere firmar transacciones on-chain, ` +
    `lo cual aún no está implementado en el bot.</i>`,
    { parse_mode: 'HTML' }
  );
}

async function handleWithdrawCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const amountStr = match?.[1];

  if (!amountStr) {
    await bot?.sendMessage(
      msg.chat.id,
      `💸 <b>WITHDRAW</b>\n\n` +
      `Uso: /withdraw <monto>\n` +
      `Ejemplo: /withdraw 100\n\n` +
      `Esto retirará USDC de Polymarket a tu wallet.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    await bot?.sendMessage(msg.chat.id, '❌ Monto inválido');
    return;
  }

  // Check if API is configured
  if (!isPolymarketApiConfigured()) {
    const status = getApiStatus();
    await bot?.sendMessage(
      msg.chat.id,
      `❌ <b>API no configurada</b>\n\n` +
      `Faltan credenciales:\n` +
      `• API Key: ${status.hasKey ? '✅' : '❌'}\n` +
      `• API Secret: ${status.hasSecret ? '✅' : '❌'}\n` +
      `• Passphrase: ${status.hasPassphrase ? '✅' : '❌'}\n\n` +
      `Configurá POLYMARKET_API_SECRET y POLYMARKET_API_PASSPHRASE en .env`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Check balance
  const balance = await getCachedPolymarketBalance();
  if (balance === null) {
    await bot?.sendMessage(msg.chat.id, '❌ No se pudo obtener el balance');
    return;
  }

  if (amount > balance) {
    await bot?.sendMessage(
      msg.chat.id,
      `❌ Balance insuficiente\n\nDisponible: $${balance.toFixed(2)}\nSolicitado: $${amount.toFixed(2)}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await bot?.sendMessage(msg.chat.id, `⏳ Procesando retiro de $${amount.toFixed(2)}...`);

  const result = await withdrawFromPolymarket(amount);

  if (result.success) {
    // Invalidate cache
    cachedPolymarketBalance = null;

    await bot?.sendMessage(
      msg.chat.id,
      `✅ <b>Retiro exitoso</b>\n\n` +
      `💸 Monto: $${amount.toFixed(2)} USDC\n` +
      `${result.transactionHash ? `🔗 TX: <code>${result.transactionHash}</code>` : ''}\n\n` +
      `El USDC llegará a tu wallet en unos minutos.`,
      { parse_mode: 'HTML' }
    );
  } else {
    await bot?.sendMessage(
      msg.chat.id,
      `❌ <b>Error en retiro</b>\n\n${result.error}`,
      { parse_mode: 'HTML' }
    );
  }
}

async function handleThresholdCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const valueStr = match?.[1];

  if (!valueStr) {
    await bot?.sendMessage(
      msg.chat.id,
      `⚙️ <b>THRESHOLD</b>\n\n` +
      `Actual: <b>${getThreshold()}</b>\n\n` +
      `Uso: /threshold 0.95\n` +
      `Rango válido: 0.80 - 0.99`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const value = parseFloat(valueStr);
  if (isNaN(value) || value < 0.80 || value > 0.99) {
    await bot?.sendMessage(msg.chat.id, '❌ Threshold inválido. Rango: 0.80 - 0.99');
    return;
  }

  const oldValue = getThreshold();
  setThreshold(value);

  log.info({ oldThreshold: oldValue, newThreshold: value }, 'Threshold updated via Telegram');

  await bot?.sendMessage(
    msg.chat.id,
    `✅ <b>Threshold actualizado</b>\n\n` +
    `Anterior: ${oldValue}\n` +
    `Nuevo: <b>${value}</b>\n\n` +
    `Los trades se ejecutarán cuando total < ${value}`,
    { parse_mode: 'HTML' }
  );
}

async function handleMaxPositionCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const valueStr = match?.[1];

  if (!valueStr) {
    await bot?.sendMessage(
      msg.chat.id,
      `💰 <b>MAX POSITION</b>\n\n` +
      `Actual: <b>$${getMaxPositionSize()}</b>\n\n` +
      `Uso: /maxposition 200\n` +
      `Rango válido: $10 - $1000`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const value = parseFloat(valueStr);
  if (isNaN(value) || value < 10 || value > 1000) {
    await bot?.sendMessage(msg.chat.id, '❌ Max position inválido. Rango: $10 - $1000');
    return;
  }

  const oldValue = getMaxPositionSize();
  setMaxPositionSize(value);

  log.info({ oldMaxPosition: oldValue, newMaxPosition: value }, 'Max position updated via Telegram');

  await bot?.sendMessage(
    msg.chat.id,
    `✅ <b>Max Position actualizado</b>\n\n` +
    `Anterior: $${oldValue}\n` +
    `Nuevo: <b>$${value}</b>`,
    { parse_mode: 'HTML' }
  );
}

async function handleMaxOpenCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const valueStr = match?.[1];

  if (!valueStr) {
    await bot?.sendMessage(
      msg.chat.id,
      `📊 <b>MAX OPEN POSITIONS</b>\n\n` +
      `Actual: <b>${getMaxOpenPositions()}</b>\n\n` +
      `Uso: /maxopen 5\n` +
      `Rango válido: 1 - 10`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const value = parseInt(valueStr, 10);
  if (isNaN(value) || value < 1 || value > 10) {
    await bot?.sendMessage(msg.chat.id, '❌ Max open inválido. Rango: 1 - 10');
    return;
  }

  const oldValue = getMaxOpenPositions();
  setMaxOpenPositions(value);

  log.info({ oldMaxOpen: oldValue, newMaxOpen: value }, 'Max open updated via Telegram');

  await bot?.sendMessage(
    msg.chat.id,
    `✅ <b>Max Open actualizado</b>\n\n` +
    `Anterior: ${oldValue}\n` +
    `Nuevo: <b>${value}</b>`,
    { parse_mode: 'HTML' }
  );
}

async function handleMaxCostCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const valueStr = match?.[1];

  if (!valueStr) {
    await bot?.sendMessage(
      msg.chat.id,
      `🛡️ <b>MAX TOTAL COST</b>\n\n` +
      `Actual: <b>${getMaxTotalCost()}</b>\n\n` +
      `Uso: /maxcost 0.92\n` +
      `Rango válido: 0.80 - 0.99\n\n` +
      `Este valor es el máximo costo UP+DOWN que se acepta para un trade.\n` +
      `Protege contra slippage excesivo.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const value = parseFloat(valueStr);
  if (isNaN(value) || value < 0.80 || value > 0.99) {
    await bot?.sendMessage(msg.chat.id, '❌ Max cost inválido. Rango: 0.80 - 0.99');
    return;
  }

  const oldValue = getMaxTotalCost();
  setMaxTotalCost(value);

  log.info({ oldMaxCost: oldValue, newMaxCost: value }, 'Max total cost updated via Telegram');

  await bot?.sendMessage(
    msg.chat.id,
    `✅ <b>Max Total Cost actualizado</b>\n\n` +
    `Anterior: ${oldValue}\n` +
    `Nuevo: <b>${value}</b>\n\n` +
    `Solo se ejecutarán trades con UP+DOWN ≤ ${value}`,
    { parse_mode: 'HTML' }
  );
}

async function handleConfigCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const mode = isLiveTrading ? '🔴 LIVE' : '📝 PAPER';

  await bot?.sendMessage(
    msg.chat.id,
    `⚙️ <b>CONFIGURACIÓN ACTUAL</b>\n\n` +
    `🎮 Modo: ${mode}\n` +
    `📉 Threshold: <b>${getThreshold()}</b>\n` +
    `🛡️ Max Cost: <b>${getMaxTotalCost()}</b>\n` +
    `💰 Max Position: <b>$${getMaxPositionSize()}</b>\n` +
    `📊 Max Open: <b>${getMaxOpenPositions()}</b>\n\n` +
    `<b>Comandos:</b>\n` +
    `/threshold 0.95 - Cambiar threshold\n` +
    `/maxcost 0.92 - Cambiar max cost (slippage protection)\n` +
    `/maxposition 200 - Cambiar max position\n` +
    `/maxopen 5 - Cambiar max open`,
    { parse_mode: 'HTML' }
  );
}

async function handleHelpCommand(msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id.toString() !== config.telegram.chatId) return;

  const mode = isLiveTrading ? '🔴 LIVE' : '📝 PAPER';

  const text = `
🤖 <b>Polymarket Dip Bot</b> ${mode}

<b>📊 Stats:</b>
/stats - Stats últimos 7 días
/today - Stats de hoy
/markets - Stats por mercado
/open - Posiciones abiertas

<b>💼 Wallet:</b>
/wallet - Info de wallet y balance
/withdraw X - Retirar $X de Polymarket
/golive - Activar trading REAL
/gopaper - Activar paper trading

<b>⚙️ Config:</b>
/config - Ver configuración actual
/threshold X - Cambiar threshold (ej: 0.95)
/maxcost X - Cambiar max cost (ej: 0.92)
/maxposition X - Cambiar max position (ej: 200)
/maxopen X - Cambiar max open (ej: 5)

<b>🔧 Debug:</b>
/timing - Métricas de latencia
/liquidity - Liquidez real de dips
/help - Este mensaje

<b>Actual:</b>
Threshold: ${getThreshold()} | MaxCost: ${getMaxTotalCost()} | Max: $${getMaxPositionSize()} | Open: ${getMaxOpenPositions()}
  `.trim();

  await bot?.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}

async function send(message: string): Promise<void> {
  // Strip HTML tags for console output
  const plainMessage = message.replace(/<[^>]*>/g, '');

  // Always log to console
  log.info({ notification: plainMessage.substring(0, 100) }, 'Notification');

  // Send to Telegram if configured
  if (!bot || !config.telegram.chatId) {
    return;
  }

  try {
    await bot.sendMessage(config.telegram.chatId, message, { parse_mode: 'HTML' });
  } catch (error) {
    log.error({ error }, 'Failed to send Telegram message');
  }
}

export async function notifyStartup(): Promise<void> {
  const mode = isLiveTrading ? '🔴 LIVE' : '📝 PAPER';
  const msg = `
🤖 <b>Polymarket Dip Bot Started</b> ${mode}

📊 Monitoring: ${config.markets.map((m) => m.symbol).join(', ')}
⚙️ Threshold: ${config.trading.threshold}
💰 Max position: $${config.trading.maxPositionSize}
🔢 Max open: ${config.trading.maxOpenPositions}

Ready to hunt dips! 🎯
  `.trim();

  await send(msg);
}

export async function notifyWalletDeposit(amount: number, newBalance: number): Promise<void> {
  const msg = `
💰 <b>DEPÓSITO DETECTADO!</b>

➕ Cantidad: $${amount.toFixed(2)} USDC
💼 Nuevo balance: $${newBalance.toFixed(2)} USDC

${isLiveTrading ? '🔴 Modo: LIVE TRADING' : '📝 Modo: PAPER (usa /golive para activar real)'}
  `.trim();

  await send(msg);
}

export async function notifyDipDetected(dip: DipOpportunity): Promise<void> {
  // Format window info
  let windowInfo = '';
  if (dip.marketWindow) {
    const startTime = dip.marketWindow.startTime.toISOString().substring(11, 16);
    const endTime = dip.marketWindow.endTime.toISOString().substring(11, 16);
    const windowLabel = dip.marketWindow.label === 'now' ? '🟢 NOW' : `🔮 ${dip.marketWindow.label}`;
    windowInfo = `\nWindow: ${windowLabel} (${startTime}-${endTime} UTC)`;
  }

  const msg = `
🎯 <b>DIP DETECTED!</b>

Market: ${dip.market}${windowInfo}
UP ask: $${dip.askUp.toFixed(3)}
DOWN ask: $${dip.askDown.toFixed(3)}
Total: $${dip.totalCost.toFixed(3)}

Expected profit: $${dip.expectedProfit.toFixed(3)} (${dip.profitPercent.toFixed(1)}%)
Liquidity: UP=${dip.liquidityUp.toFixed(0)} / DOWN=${dip.liquidityDown.toFixed(0)}

⏳ Executing trade...
  `.trim();

  await send(msg);
}

export async function notifyTradeExecuted(position: Position, strategy: 'A' | 'B' = 'A'): Promise<void> {
  const strategyLabel = strategy === 'A' ? '🅰️ Strategy A' : '🅱️ Strategy B';
  const strategyDesc = strategy === 'A' ? '(Buy Both)' : '(2-Leg Dump)';

  const msg = `
✅ <b>TRADE EXECUTED</b>
${strategyLabel} ${strategyDesc}

Market: ${position.market}
ID: <code>${position.id}</code>

<code>┌─────────┬──────────┬─────────┐
│ Side    │ Shares   │ Price   │
├─────────┼──────────┼─────────┤
│ UP      │ ${position.sizeUp.toFixed(1).padStart(8)} │ $${position.costUp.toFixed(3).padStart(6)} │
│ DOWN    │ ${position.sizeDown.toFixed(1).padStart(8)} │ $${position.costDown.toFixed(3).padStart(6)} │
├─────────┼──────────┼─────────┤
│ TOTAL   │          │ $${position.totalCost.toFixed(2).padStart(6)} │
└─────────┴──────────┴─────────┘</code>

Expected: $${position.expectedProfit.toFixed(2)}
⏳ Waiting for resolution...
  `.trim();

  await send(msg);
}

export async function notifyTradeFailed(market: string, error: string): Promise<void> {
  const msg = `
❌ <b>TRADE FAILED</b>

Market: ${market}
Error: ${error}

Will retry on next dip.
  `.trim();

  await send(msg);
}

export async function notifyPositionResolved(position: Position): Promise<void> {
  const profitEmoji = (position.actualProfit ?? 0) > 0 ? '💰' : '📉';
  const isStrategyB = position.id.startsWith('STB_') || position.id.startsWith('stb_');
  const strategyLabel = isStrategyB ? '🅱️ B' : '🅰️ A';
  const roi = position.totalCost > 0 ? ((position.actualProfit ?? 0) / position.totalCost * 100).toFixed(1) : '0';

  const msg = `
${profitEmoji} <b>POSITION RESOLVED</b> ${strategyLabel}

Market: ${position.market}
Outcome: ${position.outcome}

<code>┌───────────┬──────────┐
│ Cost      │ $${position.totalCost.toFixed(2).padStart(7)} │
│ Payout    │ $${(position.payout ?? 0).toFixed(2).padStart(7)} │
│ Fees      │ $${(position.fees ?? 0).toFixed(2).padStart(7)} │
├───────────┼──────────┤
│ Profit    │ $${(position.actualProfit ?? 0).toFixed(2).padStart(7)} │
│ ROI       │ ${roi.padStart(6)}% │
└───────────┴──────────┘</code>
  `.trim();

  await send(msg);
}

export async function notifyError(context: string, error: unknown): Promise<void> {
  const errorMsg = error instanceof Error ? error.message : String(error);

  const msg = `
⚠️ <b>ERROR</b>

Context: ${context}
Error: ${errorMsg}
  `.trim();

  await send(msg);
}

export async function notifyDailyStats(stats: BotStats): Promise<void> {
  const uptime = Math.floor((Date.now() - stats.startedAt) / (1000 * 60 * 60));

  const msg = `
📊 <b>DAILY STATS</b>

Uptime: ${uptime}h
Total trades: ${stats.totalTrades}
Win rate: ${stats.winRate.toFixed(1)}%

Total profit: $${stats.totalProfit.toFixed(2)}
Total fees: $${stats.totalFees.toFixed(2)}
<b>Net profit: $${stats.netProfit.toFixed(2)}</b>

Avg profit/trade: $${stats.avgProfitPerTrade.toFixed(2)}
  `.trim();

  await send(msg);
}

export async function notifyShutdown(reason: string): Promise<void> {
  const msg = `
🛑 <b>Bot Shutting Down</b>

Reason: ${reason}
  `.trim();

  await send(msg);
}

export interface PriceSummary {
  symbol: string;
  up: number;
  down: number;
  total: number;
}

export interface SessionStats {
  tradesExecuted: number;
  tradesResolved: number;
  totalVolume: number;
  totalProfit: number;
  totalFees: number;
  wsMessages?: number;
  wsUpdates?: number;
}

export async function notify15MinSummary(
  prices: PriceSummary[],
  sessionStats: SessionStats,
  paperMode: boolean
): Promise<void> {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

  const modeStr = paperMode ? '📝 PAPER' : '💵 REAL';

  // Trade status
  let tradeStr: string;
  if (sessionStats.tradesExecuted > 0) {
    tradeStr = `✅ ${sessionStats.tradesExecuted} trade${sessionStats.tradesExecuted > 1 ? 's' : ''} ejecutado${sessionStats.tradesExecuted > 1 ? 's' : ''}`;
  } else {
    tradeStr = '⏳ Sin trades este período';
  }

  // Resolution status
  let resolveStr = '';
  if (sessionStats.tradesResolved > 0) {
    const netProfit = sessionStats.totalProfit - sessionStats.totalFees;
    const profitEmoji = netProfit >= 0 ? '💰' : '📉';
    resolveStr = `\n${profitEmoji} ${sessionStats.tradesResolved} resuelto${sessionStats.tradesResolved > 1 ? 's' : ''}: $${netProfit.toFixed(2)}`;
  }

  // Volume info
  let volumeStr = '';
  if (sessionStats.totalVolume > 0) {
    volumeStr = `\n📊 Volumen: $${sessionStats.totalVolume.toFixed(2)}`;
  }

  // WebSocket stats
  let wsStr = '';
  if (sessionStats.wsMessages !== undefined && sessionStats.wsMessages > 0) {
    const msgK = (sessionStats.wsMessages / 1000).toFixed(1);
    const updK = ((sessionStats.wsUpdates ?? 0) / 1000).toFixed(1);
    wsStr = `\n📡 WS: ${msgK}k msgs / ${updK}k updates`;
  }

  const priceLines = prices.map(p => {
    const dipStatus = p.total < 0.96 ? '🎯 DIP!' : p.total < 0.98 ? '👀' : '➖';
    return `${p.symbol}: $${p.total.toFixed(3)} ${dipStatus}`;
  }).join('\n');

  const msg = `
⏰ <b>Resumen 15min</b> (${timeStr})
${modeStr}

${tradeStr}${resolveStr}${volumeStr}${wsStr}

<b>Precios:</b>
<code>${priceLines}</code>
  `.trim();

  await send(msg);
}

export async function notifyDailySummary(
  dailyStats: {
    totalTrades: number;
    resolvedTrades: number;
    totalVolume: number;
    netProfit: number;
    avgROI: number;
    byMarket: Array<{ market: string; trades: number; profit: number }>;
  }
): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-CL');

  const profitEmoji = dailyStats.netProfit >= 0 ? '💰' : '📉';

  const marketLines = dailyStats.byMarket
    .map(m => `  ${m.market}: ${m.trades} trades, $${m.profit.toFixed(2)}`)
    .join('\n');

  const msg = `
📅 <b>Resumen Diario</b> (${dateStr})

📊 Trades: ${dailyStats.totalTrades} (${dailyStats.resolvedTrades} resueltos)
💵 Volumen: $${dailyStats.totalVolume.toFixed(2)}
${profitEmoji} Profit neto: $${dailyStats.netProfit.toFixed(2)}
📈 ROI promedio: ${dailyStats.avgROI.toFixed(2)}%

<b>Por mercado:</b>
<code>${marketLines || '  Sin datos'}</code>
  `.trim();

  await send(msg);
}

// Strategy B specific notifications
export async function notifyStrategyBLeg1(market: string, side: 'UP' | 'DOWN', price: number, shares: number, dropPct: number): Promise<void> {
  const msg = `
🅱️ <b>STRATEGY B - LEG 1</b>

Market: ${market}
Dump detected: ${side} -${dropPct.toFixed(1)}%

<code>┌───────────┬──────────┐
│ Side      │ ${side.padStart(8)} │
│ Price     │ $${price.toFixed(3).padStart(7)} │
│ Shares    │ ${shares.toString().padStart(8)} │
│ Cost      │ $${(price * shares).toFixed(2).padStart(7)} │
└───────────┴──────────┘</code>

⏳ Waiting for Leg 2 hedge...
  `.trim();

  await send(msg);
}

export async function notifyStrategyBComplete(market: string, leg1Side: 'UP' | 'DOWN', leg1Price: number, leg2Price: number, totalCost: number, profit: number): Promise<void> {
  const profitEmoji = profit > 0 ? '💰' : '📉';
  const roi = totalCost > 0 ? (profit / totalCost * 100).toFixed(1) : '0';

  const msg = `
${profitEmoji} <b>STRATEGY B - COMPLETE</b>

Market: ${market}

<code>┌───────────┬──────────┐
│ Leg 1     │ $${leg1Price.toFixed(3).padStart(7)} │
│ Leg 2     │ $${leg2Price.toFixed(3).padStart(7)} │
│ Total     │ $${(leg1Price + leg2Price).toFixed(3).padStart(7)} │
├───────────┼──────────┤
│ Cost      │ $${totalCost.toFixed(2).padStart(7)} │
│ Profit    │ $${profit.toFixed(2).padStart(7)} │
│ ROI       │ ${roi.padStart(6)}% │
└───────────┴──────────┘</code>
  `.trim();

  await send(msg);
}

export async function notifyStrategyBAbandoned(market: string, leg1Side: 'UP' | 'DOWN', leg1Price: number, loss: number): Promise<void> {
  const msg = `
❌ <b>STRATEGY B - ABANDONED</b>

Market: ${market}
Leg 1: ${leg1Side} @ $${leg1Price.toFixed(3)}

Round changed before Leg 2 hedge.
<b>Loss: -$${loss.toFixed(2)}</b>
  `.trim();

  await send(msg);
}

export function getBot(): TelegramBot | null {
  return bot;
}
