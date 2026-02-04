# Polymarket Hourly Bot (1h)

Bot de arbitraje que detecta y ejecuta trades en mercados de 1 hora de Polymarket.

## Status

- **Operativo**: ✅ Sí
- **Servidor**: AWS eu-west-1 (54.229.162.200)
- **Container**: `polymarket-hourly-bot`
- **Telegram Bot**: Token separado del bot de 15m

## Qué hace

Monitorea los mercados UP/DOWN de 1 hora (BTC, ETH, SOL, XRP) buscando "dips" - situaciones donde el costo total de comprar UP + DOWN es menor a $1.00. Como uno de los dos siempre resuelve a $1.00, esto genera ganancia garantizada.

### Ejemplo
```
UP ask:  $0.55
DOWN ask: $0.42
Total:   $0.97 (3% de descuento)

Al resolver, uno paga $1.00 → Ganancia: $0.03 por share
```

## Fees (1h markets)

**Los mercados de 1h son FREE (0% fees).**

Esto hace que cualquier dip sea más rentable comparado con los mercados de 15m.

## Configuración

### Variables de entorno (.env)

```bash
# Trading mode
PAPER_TRADING=false
SIMULATE_DIPS=false
MARKET_TIMEFRAME=1h

# Polymarket Wallet
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_ADDRESS=0x...
POLYMARKET_PROXY_ADDRESS=0x...

# CLOB API
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...

# Telegram (DIFERENTE del bot de 15m)
TELEGRAM_BOT_TOKEN=8596245409:AAG...
TELEGRAM_CHAT_ID=1648556893

# RPC
POLYGON_RPC_URL=https://polygon-rpc.com

# Trading params
THRESHOLD=0.97
MAX_POSITION_SIZE=100
MAX_OPEN_POSITIONS=3
```

### Parámetros clave

| Variable | Descripción |
|----------|-------------|
| `MARKET_TIMEFRAME` | Debe ser `1h` |
| `THRESHOLD` | Costo máximo para ejecutar (0.97 = 3% descuento mínimo) |
| `MAX_POSITION_SIZE` | Máximo USDC **total** por trade (UP + DOWN combinados) |

## Diferencias con el bot de 15m

| Aspecto | 15m Bot | 1h Bot |
|---------|---------|--------|
| Fees | ~1-1.5% (variable) | **0% (gratis)** |
| Slug format | `btc-updown-15m-{ts}` | `bitcoin-up-or-down-february-2-12pm-et` |
| Rotación | Cada 15 min | Cada hora |
| Timezone | UTC timestamp | Eastern Time (ET) |

## Arquitectura

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuración desde env vars
├── market-data.ts        # WebSocket + cálculo de hora ET
├── dip-detector.ts       # Detección de dips
├── executor.ts           # Ejecución de órdenes via CLOB API
├── position-manager.ts   # Tracking de posiciones abiertas
├── resolution-tracker.ts # Monitoreo de resolución de mercados
├── notifier.ts           # Telegram notificaciones + comandos
├── db.ts                 # SQLite para persistencia
└── logger.ts             # Logging con pino
```

## Comandos Telegram

| Comando | Descripción |
|---------|-------------|
| `/status` | Estado actual del bot |
| `/wallet` | Balance del wallet |
| `/portfolio` | Portfolio completo de Polymarket |
| `/positions` | Posiciones abiertas |
| `/config` | Configuración actual |
| `/pause` | Pausar trading |
| `/resume` | Reanudar trading |

## Deployment (AWS)

```bash
# Ir al directorio
cd ~/polymarket-hourly-bot

# Levantar
docker compose up -d polymarket-hourly-bot

# Ver logs
docker logs -f polymarket-hourly-bot

# Restart completo (limpia sesiones de Telegram)
docker compose down && docker compose up -d polymarket-hourly-bot
```

### Fix permisos de data/

Si hay error `SQLITE_CANTOPEN`:
```bash
sudo chown -R 1001:1001 ~/polymarket-hourly-bot/data
```

## Problemas conocidos

### Error 409 Telegram
```
409 Conflict: terminated by other getUpdates request
```

**Causa**: Otra instancia usando el mismo token de Telegram, o tokens cruzados entre bots.

**Solución**:
```bash
docker compose down && sleep 3 && docker compose up -d polymarket-hourly-bot
```

**Importante**: Cada bot (15m y 1h) debe tener su propio `TELEGRAM_BOT_TOKEN`.

### Bot usando market cerrado (hora incorrecta)

**Síntoma**: No recibe orderbook updates, market está "closed".

**Causa**: El servidor está en UTC y el cálculo de hora ET estaba mal.

**Solución**: Se usa `Intl.DateTimeFormat` con `formatToParts()` para extraer la hora correcta en ET:

```typescript
const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hour12: false,
});
const parts = etFormatter.formatToParts(now);
const etHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
```

## Mercados monitoreados

| Símbolo | Slug pattern |
|---------|--------------|
| BTC | `bitcoin-up-or-down-{month}-{day}-{hour}{ampm}-et` |
| ETH | `ethereum-up-or-down-{month}-{day}-{hour}{ampm}-et` |
| SOL | `solana-up-or-down-{month}-{day}-{hour}{ampm}-et` |
| XRP | `xrp-up-or-down-{month}-{day}-{hour}{ampm}-et` |

Ejemplo: `bitcoin-up-or-down-february-2-12pm-et`

## Rotación de mercados

Los markets de 1h rotan cada hora en punto (12pm, 1pm, 2pm, etc. ET).

El bot:
1. Pre-fetcha tokens del próximo market 5 minutos antes de la hora
2. A la hora en punto, cambia al nuevo market
3. Reconecta el WebSocket con los nuevos token IDs

Los logs muestran:
```
⏰ HOURLY WINDOW ROTATION SCHEDULED
  currentTime: 17:36:51
  nextWindow: 18:00:00
  prefetchAt: 17:55:00
```
