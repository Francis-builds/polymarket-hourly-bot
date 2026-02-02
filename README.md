# Polymarket Dip Arbitrage Bot

Automated dip arbitrage bot for Polymarket's 15-minute crypto UP/DOWN markets.

## Strategy

**Core Concept:** When `UP_ask + DOWN_ask < $0.92`, buy both sides. One side always pays $1.00 at resolution, guaranteeing profit after fees.

**Example:**
- Buy UP @ $0.45, DOWN @ $0.45 = $0.90 total
- One side pays $1.00
- Profit: $1.00 - $0.90 - 3% fees = ~$0.07 (7.7% ROI)

## Features

- **Real-time orderbook monitoring** via Polymarket WebSocket
- **Slippage-aware execution** with VWAP calculations
- **Liquidity analysis** before trade execution
- **Dip duration tracking** for strategy optimization
- **Paper trading mode** for testing
- **Telegram notifications** for all events
- **SQLite persistence** for positions and stats

## Markets Monitored

| Symbol | Market |
|--------|--------|
| BTC | Bitcoin Up or Down (15-min) |
| ETH | Ethereum Up or Down (15-min) |
| SOL | Solana Up or Down (15-min) |
| XRP | XRP Up or Down (15-min) |

## Quick Start

### 1. Prerequisites

- Node.js 22+
- Docker (for deployment)
- Polymarket wallet with USDC on Polygon
- Telegram bot token (from @BotFather)

### 2. Local Development

```bash
# Clone repo
git clone https://github.com/Francis-builds/polymarket-dip-bot.git
cd polymarket-dip-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your values

# Run in development (paper trading)
npm run dev
```

### 3. Deploy to GCP

```bash
# Create VM (once)
gcloud compute instances create polymarket-bot \
  --zone=us-east1-b \
  --machine-type=e2-small \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB

# SSH into VM
gcloud compute ssh fran@polymarket-bot --zone=us-east1-b

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in

# Clone and deploy
git clone https://github.com/Francis-builds/polymarket-dip-bot.git
cd polymarket-dip-bot

# Create .env with your credentials
nano .env

# Start bot (only polymarket-bot service)
docker compose up -d polymarket-bot

# View logs
docker logs polymarket-dip-bot -f
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_TRADING` | Enable paper trading mode | `true` |
| `POLYMARKET_PRIVATE_KEY` | Wallet private key | Required for live |
| `POLYMARKET_ADDRESS` | Wallet address | Required for live |
| `POLYMARKET_API_KEY` | CLOB API key | Required for live |
| `POLYMARKET_API_SECRET` | CLOB API secret | Required for live |
| `POLYMARKET_PASSPHRASE` | CLOB passphrase | Required for live |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Required |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Required |
| `DIP_THRESHOLD` | Buy when total < this | `0.92` |
| `MAX_POSITION_SIZE` | Max USD per trade | `50` |
| `MAX_OPEN_POSITIONS` | Max simultaneous trades | `2` |
| `FEE_RATE` | Polymarket fee rate | `0.03` |
| `MAX_SLIPPAGE_PCT` | Max allowed slippage | `0.02` |

## How It Works

### Dip Detection

1. Subscribe to Polymarket WebSocket for orderbook updates
2. Calculate best-case cost: `askUp + askDown`
3. If cost < threshold (0.92), analyze liquidity
4. Calculate VWAP for target position size
5. Check slippage within limits
6. Execute if profitable after fees

### Dip Duration Tracking

The bot tracks how long each dip opportunity lasts:

```
🔔 DIP STARTED - $100 FOK analysis
   cost=0.89, profitPct=12.3%, liqUp=450, liqDown=380, canFill100=YES

⏱️ DIP ENDED - Duration tracking
   durationSec=47.2, minCost=0.87, maxLiqUp=520, maxLiqDown=410
```

This data helps understand:
- How fast we need to execute
- Whether $100 FOK orders can fill
- Optimal position sizing

### Position Resolution

Markets resolve every 15 minutes. The bot:
1. Checks resolution status via Polymarket API
2. Records outcome (UP or DOWN won)
3. Calculates actual profit/loss
4. Updates statistics

## Telegram Notifications

| Event | Emoji |
|-------|-------|
| Bot started | 🤖 |
| Dip detected | 🎯 |
| Trade executed | ✅ |
| Trade failed | ❌ |
| Position resolved | 💰 |
| Dip started (tracking) | 🔔 |
| Dip ended (tracking) | ⏱️ |

## Monitoring

```bash
# View live logs
docker logs polymarket-dip-bot -f

# Check container status
docker ps

# Restart bot
docker compose restart polymarket-bot

# Stop bot
docker compose down
```

## Architecture

```
src/
├── main.ts           # Entry point
├── config.ts         # Environment configuration
├── market-data.ts    # WebSocket orderbook streaming
├── dip-detector.ts   # Dip detection + duration tracking
├── executor.ts       # Trade execution (paper/live)
├── position-manager.ts # Position tracking
├── resolution-tracker.ts # Market resolution
├── liquidity-analyzer.ts # VWAP + slippage analysis
├── notifier.ts       # Telegram notifications
├── db.ts             # SQLite persistence
└── types.ts          # TypeScript types
```

## Costs

| Item | Monthly |
|------|---------|
| GCP VM (e2-small) | ~$15 |
| Disk (20GB) | ~$2 |
| Network | ~$1 |
| **Total** | **~$18/month** |

## Risk Management

- Paper trading mode for testing
- Max position size limits
- Slippage checks before execution
- Liquidity depth verification
- Cooldown between trades
- FOK orders prevent partial fills

## License

MIT
