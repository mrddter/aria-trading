# ARIA 🤖

### AI-driven Real-time Investment Agent

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Autonomous crypto trading bot powered by multi-LLM intelligence, running on Cloudflare Workers with zero hosting costs.

ARIA monitors crypto news in real-time, classifies events through a pipeline of AI models, validates signals with quantitative filters, and executes trades on Hyperliquid -- all from a serverless function that costs $0 to run.

---

## Features

- **Multi-LLM Pipeline** -- GPT-OSS 120B/20B and Llama 4 Scout running on Cloudflare Workers AI for batch classification, high-impact sentiment, and strategic trade reasoning
- **Multi-Timeframe Analysis** -- Strategist evaluates 1h + 4h indicators in parallel and rejects trades when timeframes disagree (counter-trend / bounce traps)
- **Price-Aware Sensor** -- High-impact news classifier receives multi-timeframe price snapshot (5m/1h/4h/24h + volume) and adjusts sentiment when news is already priced in
- **Multi-Exchange Support** -- Hyperliquid (primary) and Binance Futures, with a pluggable exchange interface
- **Event-Driven Trading** -- Detects breaking news from RSS, CryptoCompare, Reddit and Binance announcements, classifies via LLM, and trades within seconds
- **Trend-Reversal Early-Exit** -- Profitable positions held >60 min are closed automatically when 2 of 3 trend signals (MACD/RSI/EMA20) flip against them
- **RSI Momentum Gates** -- Anti-bounce filter blocks SHORT on oversold RSI<45, pro-momentum filter blocks LONG on falling-knife RSI<45
- **Asymmetric Regime Filter** -- Blocks SHORT in EXTREME_FEAR (F&G<35) where statistical edge favors LONG
- **Dynamic Market Regime Detection** -- Adapts leverage, position sizing, and bias across 5 market regimes
- **Experience Database** -- Self-learning D1 store that records trades, tracks patterns, and feeds historical context back to the LLM
- **Automated Audit System** -- Detects ghost trades, orphaned positions, missing SL/TP, and balance anomalies
- **Telegram Control Interface** -- Real-time notifications, performance reports, and `/close SYMBOL` for manual position closure
- **Zero Hosting Cost** -- Runs entirely on Cloudflare Workers free tier, with free LLM inference via Workers AI
- **Risk Management** -- Dynamic leverage (2x-15x), ATR-based SL/TP (1.5x SL, 1.8x TP), 4h timeout, position sizing, and software SL/TP safety net

## Architecture

```
                              ARIA Trading Pipeline
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   ┌──────────────────┐ ┌───────────────┐  ┌────────────────────┐  │
  │   │  News Sources    │ │ Fear & Greed  │  │  Exchange Market   │  │
  │   │ (CryptoCompare,  │ │    Index      │  │   Data (1h + 4h    │  │
  │   │  RSS, Reddit,    │ └───────┬───────┘  │    OHLCV klines)   │  │
  │   │  Binance Ann.)   │         │          └────────┬───────────┘  │
  │   └──────┬───────────┘         │                   │              │
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
  │   │ GPT-OSS    │ │ Llama 4     │                      │            │
  │   │ 120B + MTF │ │ Scout 17B   │     LLM Sensor       │            │
  │   │ price ctx  │ │ (batch)     │     (Workers AI)      │            │
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
  │   │  RSI gates (≥45 both dirs)       │                             │
  │   │  Anti-bounce volume filter       │                             │
  │   │  F&G asymmetric block (SHORT)    │                             │
  │   │  Min $2M 24h volume              │                             │
  │   └──────────────┬───────────────────┘                             │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐                             │
  │   │     Composite Score (0-100)      │                             │
  │   │  Sentiment 25% | Momentum 25%   │                             │
  │   │  Volatility 20% | Trend 15%     │                             │
  │   │  Regime 15%  → size scaling     │                             │
  │   └──────────────┬───────────────────┘                             │
  │                  │ (score >= 60)                                    │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │     GPT-OSS 120B Strategist      │◄───│  Experience DB    │    │
  │   │  Multi-timeframe 1h+4h alignment │    │  (D1 - patterns,  │    │
  │   │  Reject COUNTER-TREND / MIXED    │    │   trade history)  │    │
  │   └──────────────┬───────────────────┘    └───────────────────┘    │
  │                  │                                                  │
  │                  ▼                                                  │
  │   ┌──────────────────────────────────┐    ┌───────────────────┐    │
  │   │    Risk Manager & Executor       │───►│  Hyperliquid      │    │
  │   │  (position sizing, leverage,     │    │  (perps, mainnet) │    │
  │   │   4h timeout, trend-reversal     │    └───────────────────┘    │
  │   │   early-exit, soft SL/TP)        │                             │
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

ARIA uses a tiered LLM architecture where each model has a specific role, optimized for latency and JSON reliability. All models run on Cloudflare Workers AI with automatic fallback chains.

| Role | Primary Model | Fallback Chain | When |
|---|---|---|---|
| Batch Classifier | Llama 4 Scout 17B | GPT-OSS 20B | Every 5 min -- classifies normal news in 5-item batches |
| High-Impact Sensor | GPT-OSS 120B | GPT-OSS 20B → Llama 4 Scout | On breaking news -- single-item analysis with multi-timeframe price context |
| Strategist | GPT-OSS 120B | GPT-OSS 20B → Llama 4 Scout | On strong signals -- final approval/rejection with 1h+4h indicators and historical patterns |
| Executor | TypeScript Engine | -- | Always -- quant filters, risk management, order execution |

All LLM inference is **free** on the Cloudflare Workers AI free tier. The LLM layer acts purely as a **sensor and strategist** -- it classifies news and validates setups but never decides direction blindly. All trading decisions go through quant filters (RSI gates, anti-bounce, F&G regime), composite scoring, multi-timeframe alignment check, and risk management.

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
| **EXTREME_FEAR** | F&G <= 25 | 5x | 0.5x | 0.3x | 1.8x | 4 |
| **RISK_OFF** | F&G < 40 & BTC < -2% | 5x | 0.6x | 0.5x | 1.5x | 5 |
| **NEUTRAL** | Default | 10x | 1.0x | 1.0x | 1.0x | 8 |
| **RISK_ON** | F&G > 55 & BTC > +2% | 15x | 1.3x | 1.5x | 0.5x | 8 |
| **EXTREME_GREED** | F&G >= 75 | 7x | 0.5x | 0.5x | 1.3x | 4 |

Each regime also adjusts stop-loss/take-profit multipliers, minimum confidence thresholds, and rebalancing intervals.

## Composite Scoring System

Every trade candidate is scored 0-100 across five dimensions before reaching the strategist. This replaces simple threshold-based filters with a nuanced multi-factor quality gate.

| Component | Weight | What it measures |
|---|---|---|
| **Sentiment** | 25% | LLM sentiment strength, confidence, magnitude, direction alignment |
| **Momentum** | 25% | RSI zones, MACD histogram direction, MACD crossover |
| **Volatility** | 20% | ATR range (moderate is best), Bollinger Band position, volume ratio |
| **Trend** | 15% | ADX strength, directional indicator alignment, EMA20 position |
| **Regime** | 15% | Fear & Greed alignment with trade direction |

| Score Range | Action | Size Multiplier |
|---|---|---|
| 80-100 | Strong setup -- full size | 1.0x |
| 60-79 | Decent setup -- reduced size | 0.7x |
| 0-59 | Trade rejected | 0x |

The composite score is passed to the strategist LLM alongside multi-timeframe indicators (1h + 4h RSI/ADX/MACD/EMA20) and historical context, giving it quantitative backing for its approval/rejection decision. The strategist rejects outright when 1h and 4h timeframes are counter-trend.

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | Account balance, environment, and bot active status |
| `/pos` | All open positions with entry/mark price, P&L, SL/TP progress |
| `/perf` | Full performance report: win rate, Sharpe, drawdown, profit factor |
| `/costs` | LLM cost breakdown, trading P&L, and net monthly projection |
| `/exp` | Experience database stats: trades, patterns learned, news accuracy |
| `/audit` | Run manual health check: ghost trades, missing SL/TP, balance anomalies |
| `/close SYMBOL` | Manually close a position (e.g. `/close BTC` or `/close BTCUSDT`) |
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

# Optional: Binance Futures (if using Binance instead of Hyperliquid)
# npx wrangler secret put BINANCE_API_KEY
# npx wrangler secret put BINANCE_API_SECRET
```

All LLM inference runs on the Cloudflare Workers AI binding (`env.AI`) -- no external LLM API keys are required.

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
| `leverage` | 3x | 10x | Base leverage (regime adjusts dynamically) |
| `riskPerTrade` | 2% | 2% | Base risk per trade as % of balance |
| `maxPositionSizeUsdt` | $15 | $500 | Maximum notional value per position |
| `maxPositions` | 3 | 6 | Maximum simultaneous open positions |
| `enableEventDriven` | true | true | Enable event-driven trading on breaking news |
| `enableMarketNeutral` | false | true | Enable market-neutral rebalancing |

Strategy gates and timeouts are tuned in [src/trading/strategies/event-driven.ts](src/trading/strategies/event-driven.ts) and [src/trading/engine.ts](src/trading/engine.ts):

| Gate | Value | Source |
|---|---|---|
| Anti-bounce SHORT | RSI ≥ 45 required | event-driven.ts |
| Pro-momentum LONG | RSI ≥ 45 required | event-driven.ts |
| Anti-bounce SHORT volume | volume ratio ≥ 0.5 required | event-driven.ts |
| F&G SHORT block | reject SHORT if F&G < 35 | engine.ts |
| Min 24h notional volume | $2M | engine.ts |
| Loss cooldown | 1h same asset | engine.ts |
| Holding timeout | 4h | event-driven.ts |
| SL multiplier | 1.5x ATR | event-driven.ts |
| TP multiplier | 1.8x ATR | event-driven.ts |
| Trend-reversal early-exit | 2 of 3 signals (MACD/RSI/EMA20) flipped, in profit, held ≥60 min | engine.ts |

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
│   │   └── sources.ts                    # News sources (CryptoCompare, Reddit, RSS, Binance)
│   ├── sentiment/
│   │   ├── llm-sensor.ts                # LLM sentiment extraction + price-aware HIGH sensor
│   │   ├── aggregator.ts                # Signal aggregation + ranking
│   │   └── types.ts                     # Sentiment type definitions
│   ├── trading/
│   │   ├── engine.ts                     # Main trading engine (orchestrator, MTF, trend-reversal)
│   │   ├── composite-score.ts           # Multi-factor trade quality scoring (0-100)
│   │   ├── regime.ts                     # Market regime detector (5 regimes)
│   │   ├── experience.ts                # Experience database (D1-backed learning)
│   │   ├── audit.ts                      # Automated health check system
│   │   ├── performance.ts               # Performance metrics (Sharpe, drawdown, etc.)
│   │   ├── risk.ts                       # Position sizing calculator
│   │   ├── signals.ts                    # Signal type definitions
│   │   └── strategies/
│   │       ├── event-driven.ts           # Event-driven strategy + RSI/anti-bounce gates
│   │       └── market-neutral-filter.ts  # Quantitative filter (RSI, ADX, ATR, volume)
│   ├── telegram/
│   │   └── bot.ts                        # Telegram notifications + command handler
│   ├── utils/
│   │   └── indicators.ts                # Technical indicators (RSI, EMA, MACD, BB, ADX, ATR)
│   └── wavespeed/
│       ├── client.ts                     # Cost tracker + JSON extraction utilities
│       └── workers-ai.ts                 # Workers AI client (GPT-OSS, Llama 4 Scout fallback chains)
├── docs/                                 # Analysis docs and tuning playbooks
├── tests/                                # Test suite (Vitest)
├── schema.sql                            # D1 database schema
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

> **Note**: `wrangler.toml` is gitignored — copy `wrangler.toml.example` (if present) or create your own with KV/D1/AI bindings. See the Quick Start section.

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

Completed:
- [x] News deduplication in D1 to prevent trading on repeated events
- [x] Composite scoring system (multi-factor trade quality gate)
- [x] All LLM inference migrated to Workers AI (no external paid APIs)
- [x] Multi-timeframe analysis (1h + 4h) for strategist decision
- [x] Price-aware sensor with multi-timeframe price snapshot context
- [x] Trend-reversal early-exit for profitable positions
- [x] RSI momentum gates (anti-bounce SHORT, pro-momentum LONG)
- [x] Asymmetric F&G regime filter (block SHORT in EXTREME_FEAR)
- [x] Manual `/close SYMBOL` command from Telegram

Planned:
- [ ] Semantic news deduplication + aging (multi-source same story)
- [ ] Divergence detector (RSI vs price exhaustion signals)
- [ ] Strategist binary checklist (replace freeform reasoning)
- [ ] Twitter/X bot for trade transparency and social sentiment ingestion
- [ ] Kelly Criterion position sizing based on historical win/loss statistics
- [ ] Web dashboard (Cloudflare Pages)
- [ ] Expanded backtesting framework with walk-forward validation
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
