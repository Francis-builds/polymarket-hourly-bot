import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createChildLogger } from './logger.js';
import type { Position, BotStats } from './types.js';

const log = createChildLogger('db');

const DB_PATH = './data/bot.db';

let db: Database.Database | null = null;

export function initDb(): void {
  // Ensure data directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      cost_up REAL NOT NULL,
      cost_down REAL NOT NULL,
      size_up REAL NOT NULL,
      size_down REAL NOT NULL,
      total_cost REAL NOT NULL,
      expected_profit REAL NOT NULL,
      ask_up REAL,
      ask_down REAL,
      liquidity_up REAL,
      liquidity_down REAL,
      estimated_slippage REAL,
      detection_latency INTEGER,
      execution_latency INTEGER,
      total_latency INTEGER,
      outcome TEXT,
      payout REAL,
      actual_profit REAL,
      fees REAL
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

    CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      market TEXT NOT NULL,
      position_id TEXT,
      best_ask_up REAL NOT NULL,
      best_ask_down REAL NOT NULL,
      total_cost REAL NOT NULL,
      liquidity_up_5pct REAL,
      liquidity_down_5pct REAL,
      depth_up TEXT NOT NULL,
      depth_down TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON orderbook_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_market ON orderbook_snapshots(market);
  `);

  // Run migrations for existing databases
  runMigrations();

  log.info('Database initialized');
}

function runMigrations(): void {
  if (!db) return;

  // Check if new liquidity columns exist, add them if not
  const tableInfo = db.prepare('PRAGMA table_info(positions)').all() as { name: string }[];
  const columns = tableInfo.map(col => col.name);

  const migrations: { column: string; sql: string }[] = [
    { column: 'ask_up', sql: 'ALTER TABLE positions ADD COLUMN ask_up REAL' },
    { column: 'ask_down', sql: 'ALTER TABLE positions ADD COLUMN ask_down REAL' },
    { column: 'liquidity_up', sql: 'ALTER TABLE positions ADD COLUMN liquidity_up REAL' },
    { column: 'liquidity_down', sql: 'ALTER TABLE positions ADD COLUMN liquidity_down REAL' },
    { column: 'estimated_slippage', sql: 'ALTER TABLE positions ADD COLUMN estimated_slippage REAL' },
    { column: 'detection_latency', sql: 'ALTER TABLE positions ADD COLUMN detection_latency INTEGER' },
    { column: 'execution_latency', sql: 'ALTER TABLE positions ADD COLUMN execution_latency INTEGER' },
    { column: 'total_latency', sql: 'ALTER TABLE positions ADD COLUMN total_latency INTEGER' },
  ];

  for (const migration of migrations) {
    if (!columns.includes(migration.column)) {
      db.exec(migration.sql);
      log.info({ column: migration.column }, 'Migration: added column');
    }
  }
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// Position operations
export function savePosition(position: Position): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO positions (
      id, market, opened_at, resolved_at, status,
      cost_up, cost_down, size_up, size_down, total_cost, expected_profit,
      ask_up, ask_down, liquidity_up, liquidity_down, estimated_slippage,
      detection_latency, execution_latency, total_latency,
      outcome, payout, actual_profit, fees
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  stmt.run(
    position.id,
    position.market,
    position.openedAt,
    position.resolvedAt ?? null,
    position.status,
    position.costUp,
    position.costDown,
    position.sizeUp,
    position.sizeDown,
    position.totalCost,
    position.expectedProfit,
    position.askUp ?? null,
    position.askDown ?? null,
    position.liquidityUp ?? null,
    position.liquidityDown ?? null,
    position.estimatedSlippage ?? null,
    position.detectionLatency ?? null,
    position.executionLatency ?? null,
    position.totalLatency ?? null,
    position.outcome ?? null,
    position.payout ?? null,
    position.actualProfit ?? null,
    position.fees ?? null
  );
}

export function getOpenPositions(): Position[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM positions WHERE status = ?');
  const rows = stmt.all('open') as Record<string, unknown>[];

  return rows.map(rowToPosition);
}

export function getPositionById(id: string): Position | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM positions WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  return row ? rowToPosition(row) : null;
}

export function getRecentPositions(limit: number = 10): Position[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?');
  const rows = stmt.all(limit) as Record<string, unknown>[];

  return rows.map(rowToPosition);
}

function rowToPosition(row: Record<string, unknown>): Position {
  return {
    id: row.id as string,
    market: row.market as string,
    openedAt: row.opened_at as number,
    resolvedAt: row.resolved_at as number | undefined,
    status: row.status as Position['status'],
    costUp: row.cost_up as number,
    costDown: row.cost_down as number,
    sizeUp: row.size_up as number,
    sizeDown: row.size_down as number,
    totalCost: row.total_cost as number,
    expectedProfit: row.expected_profit as number,
    askUp: row.ask_up as number,
    askDown: row.ask_down as number,
    liquidityUp: row.liquidity_up as number,
    liquidityDown: row.liquidity_down as number,
    estimatedSlippage: row.estimated_slippage as number | undefined,
    detectionLatency: row.detection_latency as number | undefined,
    executionLatency: row.execution_latency as number | undefined,
    totalLatency: row.total_latency as number | undefined,
    outcome: row.outcome as 'UP' | 'DOWN' | undefined,
    payout: row.payout as number | undefined,
    actualProfit: row.actual_profit as number | undefined,
    fees: row.fees as number | undefined,
  };
}

// Stats
export function getStats(): BotStats {
  const db = getDb();

  const countStmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(COALESCE(actual_profit, 0)) as total_profit,
      SUM(COALESCE(fees, 0)) as total_fees,
      MIN(opened_at) as started_at
    FROM positions
  `);

  const row = countStmt.get() as Record<string, number | null>;

  const total = row.total ?? 0;
  const successful = row.successful ?? 0;
  const totalProfit = row.total_profit ?? 0;
  const totalFees = row.total_fees ?? 0;

  return {
    startedAt: row.started_at ?? Date.now(),
    totalTrades: total,
    successfulTrades: successful,
    failedTrades: row.failed ?? 0,
    totalProfit,
    totalFees,
    netProfit: totalProfit - totalFees,
    winRate: total > 0 ? (successful / total) * 100 : 0,
    avgProfitPerTrade: total > 0 ? totalProfit / total : 0,
  };
}

// Event logging
export function logEvent(type: string, data: Record<string, unknown>): void {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO events (type, timestamp, data) VALUES (?, ?, ?)');
  stmt.run(type, Date.now(), JSON.stringify(data));
}

// Historical queries
export function getPositionsByDate(startTs: number, endTs: number): Position[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM positions WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC');
  const rows = stmt.all(startTs, endTs) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

export function getPositionsByMarket(market: string, limit: number = 50): Position[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM positions WHERE market = ? ORDER BY opened_at DESC LIMIT ?');
  const rows = stmt.all(market, limit) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

export function getTodayPositions(): Position[] {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  return getPositionsByDate(startOfDay, endOfDay);
}

export function getPositionsLast15Min(): Position[] {
  const now = Date.now();
  const fifteenMinAgo = now - 15 * 60 * 1000;
  return getPositionsByDate(fifteenMinAgo, now);
}

export interface DailyStats {
  date: string;
  totalTrades: number;
  resolvedTrades: number;
  openTrades: number;
  resolvedVolume: number;
  openVolume: number;
  totalProfit: number;
  totalFees: number;
  netProfit: number;
  avgROI: number;
}

export function getDailyStats(daysBack: number = 7): DailyStats[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT
      date(opened_at / 1000, 'unixepoch', 'localtime') as date,
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_trades,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_trades,
      SUM(CASE WHEN status = 'resolved' THEN total_cost ELSE 0 END) as resolved_volume,
      SUM(CASE WHEN status = 'open' THEN total_cost ELSE 0 END) as open_volume,
      SUM(CASE WHEN status = 'resolved' THEN COALESCE(actual_profit, 0) ELSE 0 END) as total_profit,
      SUM(CASE WHEN status = 'resolved' THEN COALESCE(fees, 0) ELSE 0 END) as total_fees
    FROM positions
    WHERE opened_at >= ?
    GROUP BY date(opened_at / 1000, 'unixepoch', 'localtime')
    ORDER BY date DESC
  `);

  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const rows = stmt.all(cutoff) as Record<string, unknown>[];

  return rows.map(row => {
    const totalProfit = (row.total_profit as number) ?? 0;
    const totalFees = (row.total_fees as number) ?? 0;
    const resolvedVolume = (row.resolved_volume as number) ?? 0;
    const netProfit = totalProfit - totalFees;

    return {
      date: row.date as string,
      totalTrades: row.total_trades as number,
      resolvedTrades: row.resolved_trades as number,
      openTrades: row.open_trades as number,
      resolvedVolume,
      openVolume: row.open_volume as number,
      totalProfit,
      totalFees,
      netProfit,
      avgROI: resolvedVolume > 0 ? (netProfit / resolvedVolume) * 100 : 0,
    };
  });
}

export interface MarketStats {
  market: string;
  totalTrades: number;
  resolvedTrades: number;
  openTrades: number;
  resolvedVolume: number;
  netProfit: number;
  avgROI: number;
}

export function getStatsByMarket(): MarketStats[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT
      market,
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_trades,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_trades,
      SUM(CASE WHEN status = 'resolved' THEN total_cost ELSE 0 END) as resolved_volume,
      SUM(CASE WHEN status = 'resolved' THEN COALESCE(actual_profit, 0) - COALESCE(fees, 0) ELSE 0 END) as net_profit
    FROM positions
    GROUP BY market
    ORDER BY net_profit DESC
  `);

  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(row => {
    const resolvedVolume = (row.resolved_volume as number) ?? 0;
    const netProfit = (row.net_profit as number) ?? 0;

    return {
      market: row.market as string,
      totalTrades: row.total_trades as number,
      resolvedTrades: row.resolved_trades as number,
      openTrades: row.open_trades as number,
      resolvedVolume,
      netProfit,
      avgROI: resolvedVolume > 0 ? (netProfit / resolvedVolume) * 100 : 0,
    };
  });
}

export function getTopProfitableTrades(limit: number = 10): Position[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM positions
    WHERE status = 'resolved' AND actual_profit IS NOT NULL
    ORDER BY actual_profit DESC
    LIMIT ?
  `);
  const rows = stmt.all(limit) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}

// Orderbook snapshot for slippage analysis
export interface OrderbookSnapshot {
  timestamp: number;
  market: string;
  positionId?: string;
  bestAskUp: number;
  bestAskDown: number;
  totalCost: number;
  liquidityUp5pct?: number;  // Liquidity within 5% of best ask
  liquidityDown5pct?: number;
  depthUp: Array<{ price: number; size: number }>;
  depthDown: Array<{ price: number; size: number }>;
}

export function saveOrderbookSnapshot(snapshot: OrderbookSnapshot): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO orderbook_snapshots (
      timestamp, market, position_id,
      best_ask_up, best_ask_down, total_cost,
      liquidity_up_5pct, liquidity_down_5pct,
      depth_up, depth_down
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    snapshot.timestamp,
    snapshot.market,
    snapshot.positionId ?? null,
    snapshot.bestAskUp,
    snapshot.bestAskDown,
    snapshot.totalCost,
    snapshot.liquidityUp5pct ?? null,
    snapshot.liquidityDown5pct ?? null,
    JSON.stringify(snapshot.depthUp),
    JSON.stringify(snapshot.depthDown)
  );
}

export function getOrderbookSnapshots(limit: number = 100): OrderbookSnapshot[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM orderbook_snapshots ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(limit) as Record<string, unknown>[];

  return rows.map(row => ({
    timestamp: row.timestamp as number,
    market: row.market as string,
    positionId: row.position_id as string | undefined,
    bestAskUp: row.best_ask_up as number,
    bestAskDown: row.best_ask_down as number,
    totalCost: row.total_cost as number,
    liquidityUp5pct: row.liquidity_up_5pct as number | undefined,
    liquidityDown5pct: row.liquidity_down_5pct as number | undefined,
    depthUp: JSON.parse(row.depth_up as string),
    depthDown: JSON.parse(row.depth_down as string),
  }));
}
