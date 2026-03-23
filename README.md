# ARIA 🤖

### AI-driven Real-time Investment Agent

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Autonomous crypto trading bot powered by multi-LLM intelligence, running on Cloudflare Workers with zero hosting costs.

ARIA monitors crypto news in real-time, classifies events through a pipeline of AI models, validates signals with quantitative filters, and executes trades on Hyperliquid -- all from a serverless function that costs $0 to run.

---

## Features

- **Multi-LLM Pipeline** -- Llama 4 Scout for batch classification, Kimi K2 for strategic trade reasoning, Claude for deep analysis
- **Multi-Exchange Support** -- Hyperliquid (primary) and Binance Futures, with a pluggable exchange interface
- **Event-Driven Trading** -- Detects breaking news, analyzes sentiment, and trades within seconds
- **Market-Neutral Strategy** -- Maintains balanced long/short exposure to reduce directional risk
- **Dynamic Market Regime Detection** -- Adapts leverage, position sizing, and bias across 5 market regimes
- **Experience Database** -- Self-learning system that records trades, tracks patterns, and feeds historical context back to the LLM
- **Automated Audit System** -- Detects ghost trades, orphaned positions, missing SL/TP, and balance anomalies
- **Telegram Control Interface** -- Real-time notifications and interactive commands from your phone
- **Zero Hosting Cost** -- Runs entirely on Cloudflare Workers free tier, with free LLM inference via Workers AI
- **Risk Management** -- Dynamic leverage (2x-15x), ATR-based stop-loss/take-profit, position sizing, and software SL/TP safety net

## Architecture

```
                              ARIA Trading Pipeline
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   ┌──────────────┐     ┌───────────────┐     ┌──────────────────┐  │
  │   │  News Sources │     │  Fear & Greed  │     │  Exchange Market │  │
  │   │  (CryptoPanic,│     │    Index       │     │   Data (OHLCV)  │  │
  │   │   RSS feeds)  │     └───────┬───────┘     └────────┬─────────┘  │
  │   └──────┬───────┘             │                       │            │
  │          │                     │                       │            │
  │          ▼                     ▼                       │            │
  │   ┌──────────────────────────────────┐                 │            │
  │   │         Event Collector          │                 │            │
  │   │   (classify impact: HIGH/NORMAL) │                 │            │
  │   └──────┬──────────────┬────────────┘                 │            │
  │          │              │                              │            │
  │     HIGH │         NORMAL (batch)                      │            │
  │          │              │                              │            │
  │          ▼              ▼                              │            │
  │   ┌────────────┐ ┌─────────────┐                      │            │
  │   │  Claude    │ │ Llama 4     │                      │            │
  │   │  Sonnet 4.5│ │ Scout 17B   │     LLM Sensor       │            │
  │   │ (WaveSpeed)│ │ (Workers AI)│     Layer             │            │
  │   └─────┬──────┘ └──────┬──────┘                      │            │
  │         │               │                              │            │
  │         ▼               ▼                              │            │
  │   ┌──────────────────────────────────┐                 │            │
  │   │    Sentiment Aggregator          │                 │            │
  │   │  (score, confidence, magnitude)  │                 │            │
  │   └──────────────┬───────────────────┘                 │            │
  │                  │                                     │            │
  │                  ▼                                     │            │
  │   ┌──────────────────────────────────┐                 │            │
  │   │      Quantitative Filter         │◄────────────────┘            │
  │   │  RSI, ADX, ATR, Volume, EMA      │                             │
  │   │  + Market Regime Detection       │                             │
  │   │  + Min $5M 24h Volume Filter     │                             │
  │   └──────────────┬───────────────────┘                             │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │     Kimi K2 Strategist           │◄───│  Experience DB    │    │
  │   │  (approve/reject + adjust SL/TP) │    │  (D1 - patterns,  │    │
  │   │  FREE on Workers AI              │    │   trade history)  │    │
  │   └──────────────┬───────────────────┘    └───────────────────┘    │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │    Risk Manager & Executor       │───►│  Hyperliquid      │    │
  │   │  (position sizing, leverage,     │    │  (perps, mainnet) │    │
  │   │   SL/TP orders, max positions)   │    └───────────────────┘    │
  │   └──────────────┬───────────────────┘                             │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐                             │
  │   │     Telegram Bot + Audit         │                             │
  │   │  (notifications, commands,       │                             │
  │   │   automated health checks)       │                             │
  │   └──────────────────────────────────┘                             │
  │                                                                     │
  │   ─── Cloudflare Workers (Cron: every 5 min) ───────────────────   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Multi-LLM Pipeline

ARIA uses a tiered LLM architecture where each model has a specific role, optimized for cost and latency.

| Role | Model | Provider | Cost | When |
|---|---|---|---|---|
| Batch Classifier | Llama 4 Scout 17B | Cloudflare Workers AI | $0 (free tier) | Every 5 min -- classifies all normal news items |
| High-Impact Analyst | Claude Sonnet 4.5 | WaveSpeed | ~$0.002/call | On breaking news -- deep sentiment analysis |
| Strategist | Kimi K2 | Cloudflare Workers AI | $0 (free tier) | On strong signals -- trade approval/rejection |
| Fallback | Claude Haiku 4.5 | WaveSpeed | ~$0.001/call | Only if primary providers are down |
| Executor | TypeScript Engine | Cloudflare Workers | $0 | Always -- risk management, order execution |

The LLM layer acts purely as a **sensor** -- it classifies and extracts structured data from news. It never decides to buy or sell. All trading decisions go through the quantitative filter, strategist validation, and risk management engine.

## Supported Exchanges

| Exchange | Status | Features | Fees |
|---|---|---|---|
| **Hyperliquid** | Primary | Perps, cross-margin, algo SL/TP | 0.015% maker / 0.045% taker |
| **Binance Futures** | Supported | Perps, hedge mode, algo SL/TP | 0.02% maker / 0.05% taker |

The exchange layer is abstracted behind an `IExchange` interface, making it straightforward to add new exchanges.

## Market Regimes

The regime detector analyzes Fear & Greed Index and BTC 24h price action to adapt all trading parameters dynamically.

| Regime | Condition | Leverage | Size | Long Bias | Short Bias | Max Positions |
|---|---|---|---|---|---|---|
| **EXTREME_FEAR** | F&G <= 15 | 5x | 0.5x | 0.3x | 1.8x | 4 |
| **RISK_OFF** | F&G < 40 & BTC < -2% | 5x | 0.6x | 0.5x | 1.5x | 5 |
| **NEUTRAL** | Default | 10x | 1.0x | 1.0x | 1.0x | 8 |
| **RISK_ON** | F&G > 55 & BTC > +2% | 15x | 1.3x | 1.5x | 0.5x | 8 |
| **EXTREME_GREED** | F&G >= 80 | 7x | 0.5x | 0.5x | 1.3x | 4 |

Each regime also adjusts stop-loss/take-profit multipliers, minimum confidence thresholds, and rebalancing intervals.

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | Account balance, environment, and bot active status |
| `/pos` | All open positions with entry/mark price, P&L, SL/TP progress |
| `/perf` | Full performance report: win rate, Sharpe, drawdown, profit factor |
| `/costs` | LLM cost breakdown, trading P&L, and net monthly projection |
| `/exp` | Experience database stats: trades, patterns learned, news accuracy |
| `/audit` | Run manual health check: ghost trades, missing SL/TP, balance anomalies |
| `/help` | List all available commands |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Hyperliquid account](https://app.hyperliquid.xyz/) with USDC deposited
- Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

### 1. Clone and Install

```bash
git clone https://github.com/loopotv/aria-trading.git
cd aria-trading
npm install
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
npx wrangler login

# Create KV namespace for cost tracking
npx wrangler kv namespace create COSTS

# Create D1 database for experience memory
npx wrangler d1 create trading-experience

# Initialize the database schema
npx wrangler d1 execute trading-experience --file=./schema.sql
```

Update `wrangler.toml` with the KV namespace ID and D1 database ID from the output above.

### 3. Configure Secrets

```bash
# Hyperliquid wallet private key (for signing orders)
npx wrangler secret put HL_PRIVATE_KEY

# Telegram bot
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# WaveSpeed API key (for Claude high-impact analysis)
npx wrangler secret put WAVESPEED_API_KEY

# Optional: Binance Futures (if using Binance instead of Hyperliquid)
# npx wrangler secret put BINANCE_API_KEY
# npx wrangler secret put BINANCE_API_SECRET
```

### 4. Configure Exchange

In `wrangler.toml`, set the exchange and wallet address:

```toml
[vars]
EXCHANGE = "hyperliquid"         # "hyperliquid" or "binance"
HL_WALLET_ADDRESS = "0x..."      # Your Ethereum wallet address
BOT_ACTIVE = "true"              # Kill switch
```

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Set Up Telegram Webhook

```bash
# Register the webhook with Telegram
curl -X POST https://your-worker.workers.dev/webhook/telegram/register
```

### 7. Verify

```bash
# Check health
curl https://your-worker.workers.dev/health

# Send /status in your Telegram bot
```

## Configuration

All runtime configuration is in `wrangler.toml`:

```toml
[vars]
EXCHANGE = "hyperliquid"       # "hyperliquid" or "binance"
HL_WALLET_ADDRESS = "0x..."    # Hyperliquid wallet address
BOT_ACTIVE = "true"            # Kill switch - set to "false" to pause all trading
```

Trading parameters are defined in `src/index.ts` within the `EngineConfig`:

| Parameter | Hyperliquid | Binance | Description |
|---|---|---|---|
| `symbols` | 14 pairs | 10 pairs | Watchlist for market-neutral strategy |
| `leverage` | 3x | 10x | Base leverage (regime adjusts dynamically) |
| `riskPerTrade` | 2% | 2% | Base risk per trade as % of balance |
| `maxPositionSizeUsdt` | $15 | $500 | Maximum notional value per position |
| `maxPositions` | 3 | 6 | Maximum simultaneous open positions |
| `enableEventDriven` | true | true | Enable event-driven trading on breaking news |
| `enableMarketNeutral` | false | true | Enable market-neutral rebalancing |

## Project Structure

```
aria-trading/
├── src/
│   ├── index.ts                          # Entry point, routes, cron handler
│   ├── exchange/
│   │   └── types.ts                      # IExchange interface + shared types
│   ├── binance/
│   │   ├── client.ts                     # Binance Futures API client
│   │   ├── auth.ts                       # HMAC signature generation
│   │   └── types.ts                      # Binance API type definitions
│   ├── hyperliquid/
│   │   ├── client.ts                     # Hyperliquid API client (IExchange)
│   │   └── auth.ts                       # EIP-712 signing for L1 actions
│   ├── ingestion/
│   │   ├── collector.ts                  # News event collector + impact classifier
│   │   └── sources.ts                    # News source definitions (CryptoPanic, RSS)
│   ├── sentiment/
│   │   ├── llm-sensor.ts                # LLM-based sentiment extraction
│   │   ├── aggregator.ts                # Signal aggregation + ranking
│   │   └── types.ts                     # Sentiment type definitions
│   ├── trading/
│   │   ├── engine.ts                     # Main trading engine (pipeline orchestrator)
│   │   ├── regime.ts                     # Market regime detector (5 regimes)
│   │   ├── experience.ts                # Experience database (D1-backed learning)
│   │   ├── audit.ts                      # Automated health check system
│   │   ├── performance.ts               # Performance metrics (Sharpe, drawdown, etc.)
│   │   ├── risk.ts                       # Position sizing calculator
│   │   ├── signals.ts                    # Signal type definitions
│   │   └── strategies/
│   │       ├── event-driven.ts           # Event-driven strategy logic
│   │       └── market-neutral-filter.ts  # Quantitative filter (RSI, ADX, ATR, volume)
│   ├── telegram/
│   │   └── bot.ts                        # Telegram notifications + command handler
│   ├── utils/
│   │   └── indicators.ts                # Technical indicators (RSI, EMA, MACD, BB, ADX, ATR)
│   └── wavespeed/
│       ├── client.ts                     # WaveSpeed LLM gateway + cost tracker
│       ├── nvidia.ts                     # NVIDIA NIM client (legacy, unused)
│       └── workers-ai.ts                # Workers AI client (Llama 4 Scout + Kimi K2)
├── tests/                                # Test suite (Vitest)
├── schema.sql                            # D1 database schema
├── wrangler.toml                         # Cloudflare Workers configuration
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Security

- **Encrypted secrets** -- All API keys and private keys are stored as Cloudflare Worker secrets, encrypted at rest. Never committed to source control.
- **Telegram chat lock** -- Commands are restricted to a single authorized chat ID. Messages from other chats are silently ignored.
- **Hardcoded API URLs** -- Exchange base URLs are hardcoded constants in the clients, preventing redirect attacks via environment variable manipulation.
- **EIP-712 signing** -- Hyperliquid orders are signed locally with the private key using standard Ethereum typed data signatures. The key never leaves the Worker.
- **Error sanitization** -- API keys are redacted from all error messages before logging or sending to Telegram.
- **Rate limiting** -- Cron-based execution naturally rate-limits all operations. Max 3 high-impact events and 15 normal items processed per cycle.
- **Automated audit** -- Periodic health checks detect ghost trades, orphaned positions, and balance anomalies.
- **Kill switch** -- Set `BOT_ACTIVE=false` in the Cloudflare dashboard to immediately halt all trading activity.

## Roadmap

- [ ] Web dashboard (Cloudflare Pages)
- [ ] Expanded backtesting framework
- [ ] News deduplication in D1 to prevent trading on repeated events
- [ ] Additional strategies (mean reversion, momentum)
- [ ] Additional exchange support (Bybit, OKX)
- [ ] On-chain data integration

## Disclaimer

This software is provided for **educational and research purposes only**. It is not financial advice.

- Cryptocurrency trading involves substantial risk of loss and is not suitable for every investor.
- Past performance, whether simulated or live, does not guarantee future results.
- The authors are not responsible for any financial losses incurred through the use of this software.
- Never trade with funds you cannot afford to lose.

## License

This project is licensed under the [MIT License](LICENSE).

## Contributing

Contributions are welcome. Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Write tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Commit your changes with clear, descriptive messages
6. Open a pull request against `master`

For bug reports or feature requests, please open an issue.
