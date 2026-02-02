import 'dotenv/config';

const isPaperMode = process.env.PAPER_TRADING === 'true';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireEnvUnlessPaper(name: string, paperDefault: string): string {
  if (isPaperMode) {
    return process.env[name] ?? paperDefault;
  }
  return requireEnv(name);
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  // Blockchain
  privateKey: requireEnvUnlessPaper('POLYMARKET_PRIVATE_KEY', '0x0000000000000000000000000000000000000000000000000000000000000001'),
  polygonRpcUrl: requireEnvUnlessPaper('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
  chainId: 137, // Polygon mainnet

  // Polymarket CLOB API Credentials (required for real trading)
  // Generate these at https://polymarket.com/settings -> API Keys
  clobApi: {
    key: requireEnvUnlessPaper('POLYMARKET_API_KEY', ''),
    secret: requireEnvUnlessPaper('POLYMARKET_API_SECRET', ''),
    passphrase: requireEnvUnlessPaper('POLYMARKET_API_PASSPHRASE', ''),
  },

  // Polymarket proxy wallet address (for accounts created via Polymarket.com)
  proxyWalletAddress: optionalEnv('POLYMARKET_PROXY_ADDRESS', ''),

  // Telegram (optional in paper mode - logs to console)
  telegram: {
    botToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
    chatId: optionalEnv('TELEGRAM_CHAT_ID', ''),
  },

  // Trading parameters
  trading: {
    threshold: parseFloat(optionalEnv('DIP_THRESHOLD', '0.94')),
    minProfit: parseFloat(optionalEnv('MIN_PROFIT', '0.03')),
    maxPositionSize: parseFloat(optionalEnv('MAX_POSITION_SIZE', '300')),
    maxOpenPositions: parseInt(optionalEnv('MAX_OPEN_POSITIONS', '3'), 10),
    cooldownMs: parseInt(optionalEnv('COOLDOWN_MS', '30000'), 10),
    // Risk management - position sizing as % of account
    riskPerTrade: parseFloat(optionalEnv('RISK_PER_TRADE', '0.05')), // 5% default
    initialBalance: parseFloat(optionalEnv('INITIAL_BALANCE', '1000')), // Starting balance for paper trading
    // Slippage and liquidity settings
    maxSlippagePct: parseFloat(optionalEnv('MAX_SLIPPAGE_PCT', '0.02')), // 2% max slippage allowed
    maxSlippage: parseFloat(optionalEnv('MAX_SLIPPAGE', '0.02')), // 2% max slippage for liquidity analyzer
    minProfitAfterSlippage: parseFloat(optionalEnv('MIN_PROFIT_AFTER_SLIPPAGE', '0.01')), // 1% min profit after slippage
    minLiquidityMultiple: parseFloat(optionalEnv('MIN_LIQUIDITY_MULTIPLE', '2')), // Need 2x target size available
    // Fees
    feeRate: parseFloat(optionalEnv('FEE_RATE', '0.03')), // 3% Polymarket fee on 15-min markets
  },

  // Strategy B (2-leg dump)
  strategyB: {
    enabled: optionalEnv('STRATEGY_B_ENABLED', 'false') === 'true',
    shares: parseFloat(optionalEnv('STRATEGY_B_SHARES', '50')),
    sumTarget: parseFloat(optionalEnv('STRATEGY_B_SUM_TARGET', '0.95')),
    movePct: parseFloat(optionalEnv('STRATEGY_B_MOVE_PCT', '0.15')),
    windowMin: parseInt(optionalEnv('STRATEGY_B_WINDOW_MIN', '2'), 10),
  },

  // Market timeframe (1h, 4h, or daily) - NO 15m in this bot (use polymarket-dip-bot for 15m)
  marketTimeframe: optionalEnv('MARKET_TIMEFRAME', '1h') as '1h' | '4h' | 'daily',

  // Markets to monitor
  markets: [
    { symbol: 'BTC', name: 'Bitcoin' },
    { symbol: 'ETH', name: 'Ethereum' },
    { symbol: 'SOL', name: 'Solana' },
    { symbol: 'XRP', name: 'XRP' },
  ],

  // Fee rates by timeframe (15m has 3% taker fee, 1h is free)
  feeRates: {
    '15m': 0.03,  // 3% taker fee
    '1h': 0.00,   // FREE
    '4h': 0.00,   // FREE
    'daily': 0.00, // FREE
  } as Record<string, number>,

  // Environment
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),

  // Paper trading mode
  paperTrading: optionalEnv('PAPER_TRADING', 'false') === 'true',
  simulateDips: optionalEnv('SIMULATE_DIPS', 'false') === 'true',
} as const;

export type Config = typeof config;
