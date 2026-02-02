#!/usr/bin/env node
/**
 * CLI para ver estadísticas históricas del bot
 *
 * Uso:
 *   npx tsx src/stats-cli.ts [comando]
 *
 * Comandos:
 *   today       - Stats de hoy
 *   daily       - Stats por día (últimos 7 días)
 *   markets     - Stats por mercado
 *   recent [n]  - Últimos n trades (default 10)
 *   top [n]     - Top n trades más rentables (default 10)
 */

import { initDb, getTodayPositions, getDailyStats, getStatsByMarket, getRecentPositions, getTopProfitableTrades, closeDb } from './db.js';
import type { Position } from './types.js';

function formatPosition(p: Position): string {
  const status = p.status === 'resolved' ? '✅' : p.status === 'open' ? '⏳' : '❌';
  const profit = p.actualProfit != null ? `$${p.actualProfit.toFixed(2)}` : 'pending';
  const roi = p.actualProfit != null && p.totalCost > 0
    ? `${((p.actualProfit / p.totalCost) * 100).toFixed(1)}%`
    : '-';
  const date = new Date(p.openedAt).toLocaleString('es-CL');
  const cost = p.totalCost?.toFixed(2) ?? '0.00';

  return `${status} ${p.market.padEnd(5)} | Cost: $${cost.padStart(6)} | Profit: ${profit.padStart(7)} | ROI: ${roi.padStart(6)} | ${date}`;
}

function printTodayStats(): void {
  const positions = getTodayPositions();
  const resolved = positions.filter(p => p.status === 'resolved');
  const open = positions.filter(p => p.status === 'open');

  const resolvedVolume = resolved.reduce((sum, p) => sum + p.totalCost, 0);
  const openVolume = open.reduce((sum, p) => sum + p.totalCost, 0);
  const totalProfit = resolved.reduce((sum, p) => sum + (p.actualProfit ?? 0), 0);
  const totalFees = resolved.reduce((sum, p) => sum + (p.fees ?? 0), 0);
  const netProfit = totalProfit - totalFees;

  console.log('\n📅 STATS DE HOY');
  console.log('═'.repeat(50));
  console.log(`Trades totales:    ${positions.length}`);
  console.log(`  - Resueltos:     ${resolved.length}`);
  console.log(`  - Abiertos:      ${open.length}`);
  console.log('');
  console.log(`Volumen resuelto:  $${resolvedVolume.toFixed(2)}`);
  console.log(`Volumen en juego:  $${openVolume.toFixed(2)}`);
  console.log('');
  console.log('--- Solo trades resueltos ---');
  console.log(`Profit bruto:      $${totalProfit.toFixed(2)}`);
  console.log(`Fees:              $${totalFees.toFixed(2)}`);
  console.log(`Profit neto:       $${netProfit.toFixed(2)}`);
  if (resolvedVolume > 0) {
    console.log(`ROI:               ${((netProfit / resolvedVolume) * 100).toFixed(2)}%`);
  }
  console.log('');
}

function printDailyStats(): void {
  const stats = getDailyStats(7);

  console.log('\n📊 STATS DIARIOS (últimos 7 días)');
  console.log('═'.repeat(70));
  console.log('Fecha        | Trades | Resueltos | Volumen    | Profit     | ROI');
  console.log('─'.repeat(70));

  for (const day of stats) {
    console.log(
      `${day.date}   | ${day.totalTrades.toString().padStart(6)} | ${day.resolvedTrades.toString().padStart(9)} | $${day.resolvedVolume.toFixed(2).padStart(8)} | $${day.netProfit.toFixed(2).padStart(8)} | ${day.avgROI.toFixed(1)}%`
    );
  }

  // Totals
  const totals = stats.reduce(
    (acc, d) => ({
      trades: acc.trades + d.totalTrades,
      resolved: acc.resolved + d.resolvedTrades,
      volume: acc.volume + d.resolvedVolume,
      profit: acc.profit + d.netProfit,
    }),
    { trades: 0, resolved: 0, volume: 0, profit: 0 }
  );

  console.log('─'.repeat(70));
  console.log(
    `TOTAL        | ${totals.trades.toString().padStart(6)} | ${totals.resolved.toString().padStart(9)} | $${totals.volume.toFixed(2).padStart(8)} | $${totals.profit.toFixed(2).padStart(8)} | ${totals.volume > 0 ? ((totals.profit / totals.volume) * 100).toFixed(1) : 0}%`
  );
  console.log('');
}

function printMarketStats(): void {
  const stats = getStatsByMarket();

  console.log('\n📈 STATS POR MERCADO (solo resueltos)');
  console.log('═'.repeat(60));
  console.log('Mercado | Resueltos | Volumen    | Profit     | ROI');
  console.log('─'.repeat(60));

  for (const m of stats) {
    console.log(
      `${m.market.padEnd(7)} | ${m.resolvedTrades.toString().padStart(9)} | $${m.resolvedVolume.toFixed(2).padStart(8)} | $${m.netProfit.toFixed(2).padStart(8)} | ${m.avgROI.toFixed(1)}%`
    );
  }
  console.log('');
}

function printRecentTrades(n: number): void {
  const positions = getRecentPositions(n);

  console.log(`\n🕐 ÚLTIMOS ${n} TRADES`);
  console.log('═'.repeat(80));

  if (positions.length === 0) {
    console.log('No hay trades registrados');
  } else {
    for (const p of positions) {
      console.log(formatPosition(p));
    }
  }
  console.log('');
}

function printTopTrades(n: number): void {
  const positions = getTopProfitableTrades(n);

  console.log(`\n🏆 TOP ${n} TRADES MÁS RENTABLES`);
  console.log('═'.repeat(80));

  if (positions.length === 0) {
    console.log('No hay trades resueltos');
  } else {
    for (const p of positions) {
      console.log(formatPosition(p));
    }
  }
  console.log('');
}

function printHelp(): void {
  console.log(`
Polymarket Dip Bot - Stats CLI

Uso: npx tsx src/stats-cli.ts [comando]

Comandos:
  today           Stats de hoy
  daily           Stats por día (últimos 7 días)
  markets         Stats por mercado
  recent [n]      Últimos n trades (default 10)
  top [n]         Top n trades más rentables (default 10)
  all             Mostrar todo
  help            Mostrar esta ayuda
`);
}

async function main(): Promise<void> {
  initDb();

  const command = process.argv[2] || 'all';
  const arg = parseInt(process.argv[3] || '10', 10);

  switch (command) {
    case 'today':
      printTodayStats();
      break;
    case 'daily':
      printDailyStats();
      break;
    case 'markets':
      printMarketStats();
      break;
    case 'recent':
      printRecentTrades(arg);
      break;
    case 'top':
      printTopTrades(arg);
      break;
    case 'all':
      printTodayStats();
      printDailyStats();
      printMarketStats();
      printRecentTrades(10);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.log(`Comando desconocido: ${command}`);
      printHelp();
  }

  closeDb();
}

main().catch(console.error);
