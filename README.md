# ARIA 🤖

### AI-driven Real-time Investment Agent

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Autonomous crypto trading bot powered by multi-LLM intelligence, running on Cloudflare Workers with zero hosting costs.

ARIA monitors crypto news in real-time, classifies events through a pipeline of AI models, validates signals with quantitative filters, and executes trades on Binance Futures -- all from a serverless function that costs $0 to run.

---

## Features

- **Multi-LLM Pipeline** -- Llama 4 Scout for batch classification, Qwen 3.5 for deep analysis and strategic reasoning
- **Event-Driven Trading** -- Detects breaking news, analyzes sentiment, and trades within seconds
- **Market-Neutral Strategy** -- Maintains balanced long/short exposure to reduce directional risk
- **Dynamic Market Regime Detection** -- Adapts leverage, position sizing, and bias across 5 market regimes
- **Experience Database** -- Self-learning system that records trades, tracks patterns, and feeds historical context back to the LLM
- **Telegram Control Interface** -- Real-time notifications and interactive commands from your phone
- **Zero Hosting Cost** -- Runs entirely on Cloudflare Workers free tier, with free LLM inference via Workers AI and NVIDIA NIM
- **Risk Management** -- Dynamic leverage (3x-15x), ATR-based stop-loss/take-profit, position sizing, and software SL/TP safety net

## Architecture

```
                              ARIA Trading Pipeline
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   ┌──────────────┐     ┌───────────────┐     ┌──────────────────┐  │
  │   │  News Sources │     │  Fear & Greed  │     │  Binance Market  │  │
  │   │  (CryptoPanic,│     │    Index       │     │    Data (OHLCV)  │  │
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
  │   │  Qwen 3.5  │ │ Llama 4     │                      │            │
  │   │  122B      │ │ Scout 17B   │     LLM Sensor       │            │
  │   │ (NVIDIA)   │ │ (Workers AI)│     Layer             │            │
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
  │   └──────────────┬───────────────────┘                             │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │     Qwen 3.5 Strategist          │◄───│  Experience DB    │    │
  │   │  (chain-of-thought reasoning)    │    │  (D1 - patterns,  │    │
  │   │  approve/reject + adjust SL/TP   │    │   trade history)  │    │
  │   └──────────────┬───────────────────┘    └───────────────────┘    │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │    Risk Manager & Executor       │───►│  Binance Futures  │    │
  │   │  (position sizing, leverage,     │    │  (testnet/mainnet)│    │
  │   │   SL/TP orders, max positions)   │    └───────────────────┘    │
  │   └──────────────┬───────────────────┘                             │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐                             │
  │   │         Telegram Bot             │                             │
  │   │  (notifications + commands)      │                             │
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
| High-Impact Analyst | Qwen 3.5 122B | NVIDIA NIM | $0 (free tier) | On breaking news -- deep sentiment analysis |
| Strategist | Qwen 3.5 122B | NVIDIA NIM | $0 (free tier) | On strong signals -- chain-of-thought trade approval |
| Fallback | Claude Haiku 4.5 | WaveSpeed | ~$0.001/call | Only if primary providers are down |
| Executor | TypeScript Engine | Cloudflare Workers | $0 | Always -- risk management, order execution |

The LLM layer acts purely as a **sensor** -- it classifies and extracts structured data from news. It never decides to buy or sell. All trading decisions go through the quantitative filter and risk management engine.

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
| `/pos` | All open positions with entry price, mark price, P&L |
| `/perf` | Full performance report: win rate, Sharpe, drawdown, profit factor |
| `/costs` | LLM cost breakdown, trading P&L, and net monthly projection |
| `/exp` | Experience database stats: trades, patterns learned, news accuracy |
| `/help` | List all available commands |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Binance Futures testnet account](https://testnet.binancefuture.com/)
- Telegram bot token (create one via [@BotFather](https://t.me/BotFather))
- [NVIDIA NIM API key](https://build.nvidia.com/) (free tier available)

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
# Binance Futures testnet API keys
npx wrangler secret put BINANCE_API_KEY
npx wrangler secret put BINANCE_API_SECRET

# NVIDIA NIM API key (for Qwen 3.5)
npx wrangler secret put NVIDIA_API_KEY

# Telegram bot
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# WaveSpeed API key (fallback LLM provider)
npx wrangler secret put WAVESPEED_API_KEY
```

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Set Up Telegram Webhook

```bash
# Register the webhook with Telegram
curl -X POST https://your-worker.workers.dev/webhook/telegram/register
```

### 6. Verify

```bash
# Check health
curl https://your-worker.workers.dev/health

# Send /status in your Telegram bot
```

The bot starts in **testnet mode** by default (`ENVIRONMENT = "testnet"` in `wrangler.toml`). All trades will execute against the Binance Futures testnet with no real funds at risk.

## Configuration

All runtime configuration is in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "testnet"    # "testnet" or "mainnet"
BOT_ACTIVE = "true"        # Kill switch - set to "false" to pause all trading
```

Trading parameters are defined in `src/index.ts` within the `EngineConfig`:

| Parameter | Default | Description |
|---|---|---|
| `symbols` | 10 major pairs | Watchlist: BTC, ETH, BNB, SOL, XRP, DOGE, ADA, AVAX, DOT, LINK |
| `leverage` | 10x | Base leverage (regime adjusts between 3x-15x) |
| `riskPerTrade` | 2% | Base risk per trade as % of balance |
| `maxPositionSizeUsdt` | $500 | Maximum notional value per position |
| `maxPositions` | 6 | Maximum simultaneous open positions |
| `enableEventDriven` | true | Enable event-driven trading on breaking news |
| `enableMarketNeutral` | true | Enable market-neutral rebalancing |

## Project Structure

```
aria/
├── src/
│   ├── index.ts                          # Entry point, routes, cron handler
│   ├── binance/
│   │   ├── client.ts                     # Binance Futures API client
│   │   ├── auth.ts                       # HMAC signature generation
│   │   └── types.ts                      # Binance API type definitions
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
│       ├── nvidia.ts                     # NVIDIA NIM client (Qwen 3.5 strategist)
│       └── workers-ai.ts                # Cloudflare Workers AI client (Llama 4 Scout)
├── backtest/                             # Backtesting framework
├── tests/                                # Test suite (Vitest)
├── schema.sql                            # D1 database schema
├── wrangler.toml                         # Cloudflare Workers configuration
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Security

- **Encrypted secrets** -- All API keys are stored as Cloudflare Worker secrets, encrypted at rest. Never committed to source control.
- **Telegram chat lock** -- Commands are restricted to a single authorized chat ID. Messages from other chats are silently ignored.
- **Hardcoded API URLs** -- Binance base URLs are hardcoded constants in the client, preventing redirect attacks via environment variable manipulation.
- **Error sanitization** -- API keys are redacted from all error messages before logging or sending to Telegram.
- **Rate limiting** -- Cron-based execution naturally rate-limits all operations. Max 3 high-impact events and 15 normal items processed per cycle.
- **Kill switch** -- Set `BOT_ACTIVE=false` in the Cloudflare dashboard to immediately halt all trading activity.

## Roadmap

- [ ] Web dashboard (Cloudflare Pages)
- [ ] Expanded backtesting framework
- [ ] Additional strategies (mean reversion, momentum)
- [ ] Multi-exchange support (Bybit, OKX)
- [ ] Community strategy marketplace
- [ ] On-chain data integration

## Disclaimer

This software is provided for **educational and research purposes only**. It is not financial advice.

- Cryptocurrency trading involves substantial risk of loss and is not suitable for every investor.
- Past performance, whether simulated or live, does not guarantee future results.
- The authors are not responsible for any financial losses incurred through the use of this software.
- **Always start with testnet.** The bot defaults to testnet mode for a reason.
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
6. Open a pull request against `main`

For bug reports or feature requests, please open an issue.
