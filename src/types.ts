// Market types
export interface Market {
  symbol: string;
  name: string;
  conditionId?: string;
  tokenIdUp?: string;
  tokenIdDown?: string;
}

// Orderbook types
export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  market: string;
  timestamp: number;
  UP: {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
  };
  DOWN: {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
  };
  // Window info for multi-period monitoring
  windowOffset?: number;  // 0 = current, 1 = next, 2 = +2
  windowLabel?: string;   // "now", "+1", "+2"
}

// Market window info (current, +1, +2 periods ahead)
export interface MarketWindow {
  offset: number;       // 0 = current, 1 = next, 2 = +2
  label: string;        // "now", "+1", "+2"
  startTime: Date;      // When this market window starts
  endTime: Date;        // When this market window ends
}

// Dip detection
export interface DipOpportunity {
  market: string;
  timestamp: number;
  // Market window info
  marketWindow?: MarketWindow;
  // Best ask prices (top of book)
  askUp: number;
  askDown: number;
  // Actual fill prices after considering depth
  avgFillPriceUp: number;
  avgFillPriceDown: number;
  // Costs
  totalCost: number; // Based on actual fill prices
  bestCaseCost: number; // Based on best ask prices (for comparison)
  // Profit calculations (after slippage)
  expectedProfit: number;
  profitPercent: number;
  // Slippage info
  slippageUp: number; // as decimal (0.01 = 1%)
  slippageDown: number;
  totalSlippage: number;
  // Liquidity
  liquidityUp: number; // total available
  liquidityDown: number;
  levelsUsedUp: number; // how many price levels we need
  levelsUsedDown: number;
  detectedAt: number; // High-resolution timestamp for latency tracking
}

// Position tracking
export type PositionStatus = 'open' | 'resolved' | 'failed';

export interface Position {
  id: string;
  market: string;
  openedAt: number;
  resolvedAt?: number;
  status: PositionStatus;

  // Entry
  costUp: number;
  costDown: number;
  sizeUp: number;
  sizeDown: number;
  totalCost: number;
  expectedProfit: number;

  // Entry prices and liquidity (for analysis)
  askUp: number;
  askDown: number;
  liquidityUp: number;
  liquidityDown: number;
  estimatedSlippage?: number;

  // Latency tracking (milliseconds)
  detectionLatency?: number; // Time from orderbook update to dip detection
  executionLatency?: number; // Time from detection to trade execution complete
  totalLatency?: number; // Total time from orderbook update to execution

  // Resolution
  outcome?: 'UP' | 'DOWN';
  payout?: number;
  actualProfit?: number;
  fees?: number;
}

// Liquidity analysis result
export interface LiquidityAnalysis {
  side: 'UP' | 'DOWN';
  availableSize: number;
  vwap: number; // Volume-weighted average price
  slippage: number; // % difference from best ask
  levels: number; // How many orderbook levels needed
  fillable: boolean; // Can we fill the full size?
}

// Trade execution
export interface TradeOrder {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: 'FOK' | 'GTC' | 'GTD';
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  filledSize?: number;
  filledPrice?: number;
  error?: string;
}

// Events
export interface BotEvent {
  type: 'dip_detected' | 'trade_executed' | 'trade_failed' | 'position_resolved' | 'error';
  timestamp: number;
  data: Record<string, unknown>;
}

// Stats
export interface BotStats {
  startedAt: number;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  totalFees: number;
  netProfit: number;
  winRate: number;
  avgProfitPerTrade: number;
}
