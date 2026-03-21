# Binance Crypto Trading Bot

## Architettura: Cloudflare Workers + WaveSpeed AI + Telegram + Interfaccia Web

Trading automatico su Binance Futures (Long & Short) con notifiche Telegram, dashboard web e intelligenza decisionale basata su WaveSpeed AI (Any LLM).

---

## Indice

1. [Panoramica Architettura](#1-panoramica-architettura)
2. [Prerequisiti](#2-prerequisiti)
3. [Setup Progetto Cloudflare Workers](#3-setup-progetto-cloudflare-workers)
4. [Configurazione API Binance Futures](#4-configurazione-api-binance-futures)
5. [Bot Telegram per Notifiche](#5-bot-telegram-per-notifiche)
6. [WaveSpeed AI - LLM per Analisi di Mercato](#6-wavespeed-ai---llm-per-analisi-di-mercato)
7. [Engine di Trading (Long & Short)](#7-engine-di-trading-long--short)
8. [Interfaccia Web (Dashboard)](#8-interfaccia-web-dashboard)
9. [Cron Triggers e Strategie](#9-cron-triggers-e-strategie)
10. [Deploy e Operatività](#10-deploy-e-operatività)
11. [Sicurezza e Risk Management](#11-sicurezza-e-risk-management)

---

## 1. Panoramica Architettura

```
┌──────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE WORKERS                              │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │  Cron Trigger │  │  HTTP Router │  │  Durable Object            │  │
│  │  (ogni 1-5m) │  │  (Hono API)  │  │  (TradingState)            │  │
│  └──────┬───────┘  └──────┬───────┘  │  - posizioni aperte        │  │
│         │                 │          │  - storico ordini           │  │
│         ▼                 ▼          │  - balance tracker          │  │
│  ┌──────────────────────────────┐    └────────────────────────────┘  │
│  │   PIPELINE MULTI-AGENTE      │                                    │
│  │                              │    ┌────────────────────────────┐  │
│  │  1. COLLECTOR (no LLM)       │    │  KV Storage                │  │
│  │     fetch Binance data       │    │  - config                  │  │
│  │            │                 │◄──►│  - API keys (encrypted)    │  │
│  │            ▼                 │    └────────────────────────────┘  │
│  │  2. ANALYST (Haiku 4.5)      │                                    │
│  │     analisi tecnica + AI     │    ┌────────────────────────────┐  │
│  │            │ segnale?        │    │  D1 Database               │  │
│  │            ▼                 │    │  - trade_log               │  │
│  │  3. STRATEGIST (Sonnet 4.5)  │    │  - signals                 │  │
│  │     piano + risk/reward      │    │  - agent_logs              │  │
│  │            │ ok?             │    │  - performance             │  │
│  │            ▼                 │    └────────────────────────────┘  │
│  │  4. EXECUTOR (Sonnet 4.6)     │                                    │
│  │     decisione finale + order │                                    │
│  └──────────────┬───────────────┘                                    │
│                 │                                                    │
│  ┌──────────────▼───────────────┐                                    │
│  │   BINANCE FUTURES API        │                                    │
│  │  - fapi.binance.com          │                                    │
│  │  - USDT-M Futures            │                                    │
│  │  - Ordini MARKET/LIMIT       │                                    │
│  └──────────────────────────────┘                                    │
│                 │                                                    │
└─────────────────┼────────────────────────────────────────────────────┘
                  │
    ┌─────────────▼──────┐    ┌──────────────────────────┐
    │  TELEGRAM BOT API   │    │  WAVESPEED AI             │
    │  - Alert per fase   │    │  - Any LLM Gateway        │
    │  - P&L report       │    │  - Haiku 4.5 (Analyst)     │
    │  - Comandi manuali  │    │  - Sonnet 4.5 (Strategist) │
    └─────────────────────┘    │  - Sonnet 4.6 (Executor)   │
                               └──────────────────────────┘
    ┌─────────────────────┐
    │  DASHBOARD WEB       │
    │  (Cloudflare Pages)  │
    │  - React + Tailwind  │
    │  - Grafici P&L       │
    │  - Log agenti        │
    │  - Gestione bot      │
    └─────────────────────┘
```

### Pipeline Multi-Agente - Flusso Operativo

```
Cron (ogni 2 min)
      │
      ▼
┌─────────────┐     Sempre attivo, nessun LLM
│  COLLECTOR   │     Recupera: prezzo, candele, orderbook,
│  (fetch)     │     long/short ratio, funding rate
└──────┬──────┘
       │ dati grezzi
       ▼
┌─────────────┐     Sempre attivo, Haiku 4.5 (~$0.0017/call)
│   ANALYST    │     Calcola indicatori tecnici (RSI, EMA, MACD, BB)
│ (Haiku 4.5)  │     + chiede al LLM: "c'e un pattern rilevante?"
└──────┬──────┘
       │ segnale trovato? (strength > 0.5)
       │ NO → log + stop
       ▼
┌─────────────┐     Solo su segnale, Sonnet 4.5 (~$0.005/call)
│  STRATEGIST  │     Elabora piano: entry, SL, TP, size,
│ (Sonnet 4.5) │     risk/reward, correlazioni, contesto macro
└──────┬──────┘
       │ piano valido? (RR > 1.5, risk check ok)
       │ NO → log + stop
       ▼
┌─────────────┐     Solo su piano approvato, Sonnet 4.6 (~$0.005/call)
│  EXECUTOR    │     Decisione finale: conferma/rifiuta
│ (Sonnet 4.6) │     Se conferma → piazza ordine su Binance
└──────┬──────┘
       │
       ▼
  Binance API → Ordine → Telegram Alert → D1 Log
```

**Costo stimato pipeline** (1 simbolo, 720 cicli/giorno):

> Nell'implementazione attuale, l'Analyst LLM gira **solo quando gli indicatori tecnici puri trovano un segnale** (strength > 0.5), quindi circa il 10% dei cicli. Questo riduce drasticamente i costi.

- Collector: $0 (puro fetch)
- Analyst (Haiku 4.5): ~72 chiamate x $0.0017 = **~$0.12/giorno**
- Strategist (Sonnet 4.5): ~36 x $0.005 = **~$0.18/giorno**
- Executor (Sonnet 4.6): ~18 x $0.005 = **~$0.09/giorno**
- **Totale LLM per simbolo: ~$0.39/giorno**
- **3 simboli: ~$1.17/giorno = ~$35/mese**

> Usando tutta la famiglia Anthropic via WaveSpeed, il costo e molto contenuto. Con `claude-3-haiku` come Analyst si scende a ~$20/mese.

---

## 2. Prerequisiti

### Account e API Keys

| Servizio | Cosa serve | Link |
|----------|-----------|------|
| **Binance** | Account con Futures abilitati + API Key/Secret | [binance.com](https://www.binance.com) |
| **Cloudflare** | Account Workers (piano Free o Paid) | [cloudflare.com](https://www.cloudflare.com) |
| **Telegram** | Bot creato via @BotFather + Chat ID | [core.telegram.org/bots](https://core.telegram.org/bots) |
| **WaveSpeed AI** | API Key per Any LLM | [wavespeed.ai](https://wavespeed.ai/accesskey) |

### Strumenti Locali

```bash
# Node.js 20+
node --version

# Wrangler CLI (Cloudflare Workers)
npm install -g wrangler
wrangler --version

# Login Cloudflare
wrangler login
```

### Binance Futures - Abilitazione

1. Vai su **Binance** > Derivatives > USDT-M Futures
2. Completa il quiz di abilitazione
3. Trasferisci fondi sul wallet Futures
4. Crea API Key: **API Management** > Create API
   - Abilita: `Enable Futures`
   - **NON abilitare** withdrawals
   - Imposta IP whitelist (gli IP di Cloudflare Workers in uscita)

> **TESTNET**: Per sviluppo usa `https://testnet.binancefuture.com`
> API testnet: `https://testnet.binancefuture.com/fapi/v1/`

---

## 3. Setup Progetto Cloudflare Workers

### Inizializzazione

```bash
# Crea il progetto
npm create cloudflare@latest binance-trading-bot -- --template https://github.com/cloudflare/workers-sdk/tree/main/templates/worker-typescript
cd binance-trading-bot

# Installa dipendenze
npm install hono zod
npm install -D @cloudflare/workers-types wrangler
```

### Struttura Progetto

```
binance-trading-bot/
├── src/
│   ├── index.ts              # Entry point + cron handler
│   ├── routes/
│   │   ├── api.ts            # API endpoints (Hono router)
│   │   ├── webhook.ts        # Telegram webhook handler
│   │   └── dashboard.ts      # Dashboard API
│   ├── trading/
│   │   ├── engine.ts         # Logica di trading principale
│   │   ├── signals.ts        # Generazione segnali (indicatori)
│   │   ├── orders.ts         # Gestione ordini Binance
│   │   └── risk.ts           # Risk management
│   ├── binance/
│   │   ├── client.ts         # Client API Binance Futures
│   │   ├── auth.ts           # HMAC-SHA256 signing
│   │   └── types.ts          # Tipi TypeScript per Binance API
│   ├── telegram/
│   │   └── bot.ts            # Invio notifiche Telegram
│   ├── wavespeed/
│   │   ├── client.ts         # Client base WaveSpeed API
│   │   ├── analyst.ts        # Agente 1: Analyst (Gemini Flash)
│   │   ├── strategist.ts     # Agente 2: Strategist (Sonnet 4.5)
│   │   └── executor.ts       # Agente 3: Executor (Sonnet 4.6)
│   ├── storage/
│   │   ├── durable-object.ts # TradingState Durable Object
│   │   └── queries.ts        # Query D1
│   └── utils/
│       ├── indicators.ts     # RSI, EMA, MACD, Bollinger Bands
│       └── crypto.ts         # Utility crittografia
├── web/                      # Frontend dashboard (React)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   └── pages/
│   └── package.json
├── schema.sql                # Schema D1
├── wrangler.toml
└── package.json
```

### wrangler.toml

```toml
name = "binance-trading-bot"
main = "src/index.ts"
compatibility_date = "2026-03-01"

# Cron Triggers - esecuzione periodica
[triggers]
crons = [
  "*/2 * * * *",    # Ogni 2 minuti - check segnali
  "0 * * * *",      # Ogni ora - report P&L
  "0 0 * * *"       # Ogni giorno - report giornaliero
]

# KV Namespace per configurazione
[[kv_namespaces]]
binding = "CONFIG"
id = "YOUR_KV_NAMESPACE_ID"

# D1 Database per storico
[[d1_databases]]
binding = "DB"
database_name = "trading-bot"
database_id = "YOUR_D1_DATABASE_ID"

# Durable Objects per stato in-memory
[durable_objects]
bindings = [
  { name = "TRADING_STATE", class_name = "TradingState" }
]

[[migrations]]
tag = "v1"
new_classes = ["TradingState"]

# Secrets (da impostare via wrangler secret put)
# BINANCE_API_KEY
# BINANCE_API_SECRET
# TELEGRAM_BOT_TOKEN
# TELEGRAM_CHAT_ID
# WAVESPEED_API_KEY
# AUTH_TOKEN

[vars]
ENVIRONMENT = "production"
DASHBOARD_ORIGIN = "https://trading-dashboard.pages.dev"
# Binance URLs are hardcoded in the client to prevent API key exfiltration
# via a malicious BINANCE_BASE_URL. Set ENVIRONMENT = "testnet" for dev.
```

### Creazione Risorse Cloudflare

```bash
# Crea KV namespace
wrangler kv namespace create CONFIG
# Copia l'id nel wrangler.toml

# Crea D1 database
wrangler d1 create trading-bot
# Copia l'id nel wrangler.toml

# Imposta secrets
wrangler secret put BINANCE_API_KEY
wrangler secret put BINANCE_API_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put WAVESPEED_API_KEY
wrangler secret put AUTH_TOKEN
```

### Schema D1 (schema.sql)

```sql
-- Esegui con: wrangler d1 execute trading-bot --file=./schema.sql

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,           -- 'BUY' o 'SELL'
  position_side TEXT NOT NULL,  -- 'LONG' o 'SHORT'
  type TEXT NOT NULL,           -- 'MARKET', 'LIMIT'
  quantity REAL NOT NULL,
  price REAL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,         -- 'PENDING', 'OPEN', 'CLOSED', 'CANCELLED'
  pnl REAL DEFAULT 0,
  binance_order_id TEXT,
  signal_source TEXT,           -- 'technical', 'llm', 'manual'
  notes TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,      -- 'LONG' o 'SHORT'
  strength REAL NOT NULL,       -- 0.0 - 1.0
  indicators TEXT NOT NULL,     -- JSON con dettaglio indicatori
  action TEXT,                  -- 'OPEN', 'CLOSE', 'HOLD'
  executed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_pnl REAL DEFAULT 0,
  max_drawdown REAL DEFAULT 0,
  balance_snapshot REAL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_signals_created ON signals(created_at);
CREATE INDEX idx_daily_stats_date ON daily_stats(date);
```

---

## 4. Configurazione API Binance Futures

### Client Binance (src/binance/client.ts)

```typescript
import { createHmacSignature } from './auth';

// Tipi principali
export interface BinanceEnv {
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  ENVIRONMENT: string;
}

export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH';
export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface NewOrderParams {
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
}

export interface AccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  positions: Position[];
}

export interface Position {
  symbol: string;
  positionSide: PositionSide;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  leverage: string;
}

export class BinanceFuturesClient {
  private static readonly URLS = {
    mainnet: 'https://fapi.binance.com',
    testnet: 'https://testnet.binancefuture.com',
  } as const;

  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(env: BinanceEnv) {
    this.apiKey = env.BINANCE_API_KEY;
    this.apiSecret = env.BINANCE_API_SECRET;
    // Hardcoded URLs - never trust user-configurable base URLs
    this.baseUrl = env.ENVIRONMENT === 'testnet'
      ? BinanceFuturesClient.URLS.testnet
      : BinanceFuturesClient.URLS.mainnet;
  }

  // --- METODI PUBBLICI (Market Data - no auth) ---

  /** Prezzo corrente di un simbolo */
  async getPrice(symbol: string): Promise<number> {
    const res = await this.publicGet('/fapi/v1/ticker/price', { symbol });
    return parseFloat(res.price);
  }

  /** Candele (klines) per analisi tecnica */
  async getKlines(
    symbol: string,
    interval: string = '15m',
    limit: number = 100
  ): Promise<number[][]> {
    return this.publicGet('/fapi/v1/klines', {
      symbol,
      interval,
      limit: String(limit),
    });
  }

  /** Orderbook depth */
  async getDepth(symbol: string, limit: number = 20) {
    return this.publicGet('/fapi/v1/depth', {
      symbol,
      limit: String(limit),
    });
  }

  /** Long/Short ratio globale */
  async getLongShortRatio(symbol: string, period: string = '1h') {
    return this.publicGet('/futures/data/globalLongShortAccountRatio', {
      symbol,
      period,
      limit: '10',
    });
  }

  // --- METODI PRIVATI (Trading - con auth) ---

  /** Info account e posizioni aperte */
  async getAccountInfo(): Promise<AccountInfo> {
    return this.signedGet('/fapi/v3/account');
  }

  /** Piazza un nuovo ordine */
  async newOrder(params: NewOrderParams) {
    const orderParams: Record<string, string> = {
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      quantity: params.quantity.toString(),
    };

    if (params.price) orderParams.price = params.price.toString();
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice.toString();
    if (params.timeInForce) orderParams.timeInForce = params.timeInForce;
    if (params.type === 'LIMIT') {
      orderParams.timeInForce = params.timeInForce || 'GTC';
    }
    if (params.reduceOnly) orderParams.reduceOnly = 'true';

    return this.signedPost('/fapi/v1/order', orderParams);
  }

  /** Cancella un ordine */
  async cancelOrder(symbol: string, orderId: string) {
    return this.signedDelete('/fapi/v1/order', { symbol, orderId });
  }

  /** Imposta leva per un simbolo */
  async setLeverage(symbol: string, leverage: number) {
    return this.signedPost('/fapi/v1/leverage', {
      symbol,
      leverage: leverage.toString(),
    });
  }

  /** Imposta margin type (ISOLATED o CROSSED) */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED') {
    return this.signedPost('/fapi/v1/marginType', { symbol, marginType });
  }

  /**
   * Imposta Hedge Mode (per poter aprire LONG e SHORT simultaneamente).
   * dualSidePosition: true = Hedge Mode, false = One-way Mode
   */
  async setPositionMode(dualSidePosition: boolean) {
    return this.signedPost('/fapi/v1/positionSide/dual', {
      dualSidePosition: dualSidePosition.toString(),
    });
  }

  /** Ordini aperti per un simbolo */
  async getOpenOrders(symbol?: string) {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.signedGet('/fapi/v1/openOrders', params);
  }

  // --- SYMBOL PRECISION (Fix 7: Dynamic quantity/price precision) ---

  /** Cache per le info di precisione per simbolo */
  private symbolInfoCache: Map<string, {
    pricePrecision: number;
    quantityPrecision: number;
    tickSize: string;
    stepSize: string;
  }> = new Map();

  /**
   * Recupera le info di precisione per un simbolo da /fapi/v1/exchangeInfo.
   * I risultati vengono cachati in memoria per evitare chiamate ripetute.
   * La response contiene filters[] con PRICE_FILTER (tickSize) e LOT_SIZE (stepSize).
   */
  async getSymbolInfo(symbol: string): Promise<{
    pricePrecision: number;
    quantityPrecision: number;
    tickSize: string;
    stepSize: string;
  }> {
    const cached = this.symbolInfoCache.get(symbol);
    if (cached) return cached;

    const exchangeInfo = await this.publicGet('/fapi/v1/exchangeInfo', {});
    const symbolData = exchangeInfo.symbols?.find(
      (s: any) => s.symbol === symbol
    );

    if (!symbolData) {
      throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
    }

    const priceFilter = symbolData.filters.find(
      (f: any) => f.filterType === 'PRICE_FILTER'
    );
    const lotSize = symbolData.filters.find(
      (f: any) => f.filterType === 'LOT_SIZE'
    );

    const info = {
      pricePrecision: symbolData.pricePrecision as number,
      quantityPrecision: symbolData.quantityPrecision as number,
      tickSize: priceFilter?.tickSize || '0.01',
      stepSize: lotSize?.stepSize || '0.001',
    };

    // Cache all symbols from this response to avoid future calls
    for (const s of exchangeInfo.symbols || []) {
      const pf = s.filters.find(
        (f: any) => f.filterType === 'PRICE_FILTER'
      );
      const ls = s.filters.find(
        (f: any) => f.filterType === 'LOT_SIZE'
      );
      this.symbolInfoCache.set(s.symbol, {
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
        tickSize: pf?.tickSize || '0.01',
        stepSize: ls?.stepSize || '0.001',
      });
    }

    return info;
  }

  /**
   * Arrotonda la quantita secondo il stepSize del simbolo (LOT_SIZE filter).
   * Es: stepSize="0.001" -> 3 decimali, stepSize="0.01" -> 2 decimali.
   */
  roundQuantity(symbol: string, qty: number): number {
    const info = this.symbolInfoCache.get(symbol);
    if (!info) {
      return parseFloat(qty.toFixed(3));
    }
    const precision = this.countDecimals(info.stepSize);
    return parseFloat(qty.toFixed(precision));
  }

  /**
   * Arrotonda il prezzo secondo il tickSize del simbolo (PRICE_FILTER).
   * Es: tickSize="0.10" -> 1 decimale, tickSize="0.01" -> 2 decimali.
   */
  roundPrice(symbol: string, price: number): number {
    const info = this.symbolInfoCache.get(symbol);
    if (!info) {
      return parseFloat(price.toFixed(2));
    }
    const precision = this.countDecimals(info.tickSize);
    return parseFloat(price.toFixed(precision));
  }

  /** Conta i decimali significativi di un numero stringa (es: "0.001" -> 3) */
  private countDecimals(value: string): number {
    const num = parseFloat(value);
    if (Math.floor(num) === num) return 0;
    const parts = value.split('.');
    return parts[1]?.replace(/0+$/, '').length || 0;
  }

  /**
   * Piazza un ordine condizionale (SL/TP) via Algo API.
   * OBBLIGATORIO da Dicembre 2025: gli ordini STOP_MARKET e
   * TAKE_PROFIT_MARKET non funzionano piu su /fapi/v1/order.
   * Endpoint: POST /fapi/v1/algoOrder
   */
  async newAlgoOrder(params: {
    symbol: string;
    side: OrderSide;
    positionSide: PositionSide;
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: number;
    quantity?: number;
    closePosition?: boolean;
  }) {
    const orderParams: Record<string, string> = {
      algoType: 'CONDITIONAL',
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      triggerPrice: params.triggerPrice.toString(),
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'TRUE',
    };

    if (params.closePosition) {
      orderParams.closePosition = 'true';
    } else if (params.quantity) {
      orderParams.quantity = params.quantity.toString();
    }

    return this.signedPost('/fapi/v1/algoOrder', orderParams);
  }

  /** Cancella un ordine algo (SL/TP) */
  async cancelAlgoOrder(symbol: string, algoId: string) {
    return this.signedDelete('/fapi/v1/algoOrder', {
      symbol,
      algoId,
    });
  }

  /** Ordini algo aperti */
  async getOpenAlgoOrders(symbol?: string) {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.signedGet(
      '/fapi/v1/algoOrder/openOrders',
      params
    );
  }

  // --- METODI INTERNI ---

  /** Sanitize error messages to prevent API key leakage */
  private sanitizeError(status: number, body: string): string {
    // Remove any occurrence of the API key from error messages
    const sanitized = body.replace(
      new RegExp(this.apiKey, 'g'),
      '[REDACTED]'
    );
    // Truncate to prevent huge error messages
    return `Binance API ${status}: ${sanitized.slice(0, 200)}`;
  }

  private async publicGet(
    path: string,
    params: Record<string, string> = {}
  ) {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(this.sanitizeError(res.status, errorBody));
    }
    return res.json();
  }

  private async signedGet(
    path: string,
    params: Record<string, string> = {}
  ) {
    params.timestamp = Date.now().toString();
    params.recvWindow = '5000';
    const queryString = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(
      this.apiSecret,
      queryString
    );
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(this.sanitizeError(res.status, errorBody));
    }
    return res.json();
  }

  private async signedPost(
    path: string,
    params: Record<string, string> = {}
  ) {
    params.timestamp = Date.now().toString();
    params.recvWindow = '5000';
    const queryString = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(
      this.apiSecret,
      queryString
    );

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(this.sanitizeError(res.status, errorBody));
    }
    return res.json();
  }

  private async signedDelete(
    path: string,
    params: Record<string, string> = {}
  ) {
    params.timestamp = Date.now().toString();
    params.recvWindow = '5000';
    const queryString = new URLSearchParams(params).toString();
    const signature = await createHmacSignature(
      this.apiSecret,
      queryString
    );
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(this.sanitizeError(res.status, errorBody));
    }
    return res.json();
  }
}
```

### Signing HMAC-SHA256 (src/binance/auth.ts)

```typescript
/**
 * Firma HMAC-SHA256 per Binance API.
 * Usa la Web Crypto API disponibile in Cloudflare Workers.
 */
export async function createHmacSignature(
  secret: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    messageData
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

### Endpoint Principali Binance Futures

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/fapi/v1/ticker/price` | GET | Prezzo corrente |
| `/fapi/v1/klines` | GET | Candele OHLCV |
| `/fapi/v1/depth` | GET | Orderbook |
| `/fapi/v3/account` | GET (signed) | Info account e posizioni |
| `/fapi/v1/order` | POST (signed) | Nuovo ordine |
| `/fapi/v1/order` | DELETE (signed) | Cancella ordine |
| `/fapi/v1/leverage` | POST (signed) | Imposta leva |
| `/fapi/v1/positionSide/dual` | POST (signed) | Abilita Hedge Mode |
| `/fapi/v1/algoOrder` | POST (signed) | **Ordine condizionale (SL/TP)** |
| `/fapi/v1/algoOrder` | DELETE (signed) | Cancella ordine condizionale |
| `/fapi/v1/algoOrder/openOrders` | GET (signed) | Ordini condizionali aperti |
| `/futures/data/globalLongShortAccountRatio` | GET | Long/Short ratio |

> **IMPORTANTE (Dicembre 2025+)**: Gli ordini condizionali (STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET) **devono** usare l'endpoint `/fapi/v1/algoOrder` con `algoType=CONDITIONAL`. L'endpoint classico `/fapi/v1/order` restituisce errore `-4120 STOP_ORDER_SWITCH_ALGO`.

---

## 5. Bot Telegram per Notifiche

### Setup Bot Telegram

1. Apri Telegram e cerca **@BotFather**
2. Invia `/newbot` e segui le istruzioni
3. Salva il **token** che ricevi (es. `7123456789:AAH...`)
4. Per ottenere il **Chat ID**:
   - Avvia una conversazione con il tuo bot
   - Visita `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Trova il campo `chat.id` nella risposta

### Client Telegram (src/telegram/bot.ts)

```typescript
export class TelegramBot {
  private token: string;
  private chatId: string;
  private baseUrl: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /** Formatta prezzo con precisione dinamica */
  private formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.01) return price.toFixed(6);
    return price.toFixed(8);
  }

  /** Invia messaggio di testo con HTML */
  async sendMessage(text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      console.error('Telegram send failed:', error);
    }
  }

  // --- Messaggi preformattati per il trading ---

  /** Notifica apertura posizione */
  async notifyTradeOpen(trade: {
    symbol: string;
    side: string;
    positionSide: string;
    quantity: number;
    price: number;
    stopLoss?: number;
    takeProfit?: number;
    leverage: number;
    riskPercent?: number;
    riskRewardRatio?: number;
    reasoning?: string;
  }): Promise<void> {
    const emoji = trade.positionSide === 'LONG' ? '🟢' : '🔴';
    const direction = trade.positionSide;

    let msg = `${emoji} <b>NUOVA POSIZIONE ${direction}</b>\n\n`;
    msg += `<b>Simbolo:</b> <code>${trade.symbol}</code>\n`;
    msg += `<b>Prezzo:</b> <code>${this.formatPrice(trade.price)}</code>\n`;
    msg += `<b>Quantita:</b> <code>${trade.quantity}</code>\n`;
    msg += `<b>Leva:</b> <code>${trade.leverage}x</code>\n`;

    if (trade.stopLoss)
      msg += `<b>Stop Loss:</b> <code>${this.formatPrice(trade.stopLoss)}</code>\n`;
    if (trade.takeProfit)
      msg += `<b>Take Profit:</b> <code>${this.formatPrice(trade.takeProfit)}</code>\n`;

    const size = trade.quantity * trade.price;
    msg += `\n<b>Size:</b> <code>$${size.toFixed(2)}</code>`;

    if (trade.riskPercent) msg += `\n📊 <b>Rischio:</b> <code>${trade.riskPercent.toFixed(1)}% del balance</code>`;
    if (trade.riskRewardRatio) msg += `\n<b>R:R:</b> <code>${trade.riskRewardRatio.toFixed(1)}:1</code>`;
    if (trade.reasoning) msg += `\n<b>Motivo:</b> <i>${trade.reasoning.slice(0, 120)}</i>`;

    await this.sendMessage(msg);
  }

  /** Notifica chiusura posizione */
  async notifyTradeClose(trade: {
    symbol: string;
    positionSide: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
  }): Promise<void> {
    const profitEmoji = trade.pnl >= 0 ? '✅' : '❌';
    const direction = trade.positionSide;

    let msg = `${profitEmoji} <b>CHIUSURA ${direction}</b>\n\n`;
    msg += `<b>Simbolo:</b> <code>${trade.symbol}</code>\n`;
    msg += `<b>Entry:</b> <code>${this.formatPrice(trade.entryPrice)}</code>\n`;
    msg += `<b>Exit:</b> <code>${this.formatPrice(trade.exitPrice)}</code>\n`;
    msg += `<b>P&L:</b> <code>${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)</code>`;

    await this.sendMessage(msg);
  }

  /** Report giornaliero */
  async notifyDailyReport(stats: {
    date: string;
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    balance: number;
  }): Promise<void> {
    const emoji = stats.totalPnl >= 0 ? '📈' : '📉';

    let msg = `${emoji} <b>REPORT GIORNALIERO</b>\n`;
    msg += `<b>Data:</b> <code>${stats.date}</code>\n\n`;
    msg += `<b>Trade totali:</b> <code>${stats.totalTrades}</code>\n`;
    msg += `<b>Win rate:</b> <code>${stats.winRate.toFixed(1)}%</code>\n`;
    msg += `<b>P&L giorno:</b> <code>${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}</code>\n`;
    msg += `<b>Balance:</b> <code>$${stats.balance.toFixed(2)}</code>`;

    await this.sendMessage(msg);
  }

  /** Alert segnale di trading */
  async notifySignal(signal: {
    symbol: string;
    direction: string;
    strength: number;
    indicators: Record<string, string>;
  }): Promise<void> {
    const emoji = signal.direction === 'LONG' ? '⬆️' : '⬇️';
    const bars =
      '█'.repeat(Math.round(signal.strength * 10)) +
      '░'.repeat(10 - Math.round(signal.strength * 10));

    let msg = `${emoji} <b>SEGNALE ${signal.direction}</b>\n\n`;
    msg += `<b>Simbolo:</b> <code>${signal.symbol}</code>\n`;
    msg += `<b>Forza:</b> <code>[${bars}] ${(signal.strength * 100).toFixed(0)}%</code>\n\n`;
    msg += `<b>Indicatori:</b>\n`;

    for (const [key, value] of Object.entries(signal.indicators)) {
      msg += `  - ${key}: <code>${value}</code>\n`;
    }

    await this.sendMessage(msg);
  }
}
```

---

## 6. WaveSpeed AI - Pipeline Multi-Agente

WaveSpeed AI fornisce un gateway unificato (**Any LLM**) che permette di accedere a diversi modelli LLM con una singola API key. Il bot usa una **pipeline a 4 agenti**, ognuno specializzato con il modello piu adatto al suo compito.

### Modelli per Agente

| Agente | Modello Default | Costo/call | Quando gira |
|--------|----------------|-----------|-------------|
| **Collector** | Nessuno (puro `fetch`) | $0 | Sempre (ogni 2 min) |
| **Analyst** | `anthropic/claude-haiku-4.5` | ~$0.0017 | Sempre (ogni 2 min) |
| **Strategist** | `anthropic/claude-sonnet-4.5` | ~$0.005 | Solo su segnale (~10% cicli) |
| **Executor** | `anthropic/claude-sonnet-4.6` | ~$0.005 | Solo su piano valido (~5% cicli) |

> Ogni agente ha **skill preimpostate** nel system prompt che lo rendono uno specialista. Haiku 4.5 fa lo screening veloce, Sonnet 4.5 costruisce piani dettagliati, Sonnet 4.6 (il modello piu recente e capace) fa da ultimo gate di sicurezza.

### Stima Costi Pipeline (720 cicli/giorno, 3 simboli)

| Fase | Chiamate/giorno | Costo/giorno | Costo/mese |
|------|----------------|-------------|------------|
| Collector | 2160 | $0 | $0 |
| Analyst (Haiku 4.5) | 2160 | ~$3.67 | ~$110 |
| Strategist - Sonnet 4.5 (~10%) | ~216 | ~$1.08 | ~$32 |
| Executor - Sonnet 4.6 (~5%) | ~108 | ~$0.54 | ~$16 |
| **Totale (se Analyst gira sempre)** | | **~$5.29** | **~$158** |

> **Implementazione attuale**: l'Analyst LLM gira solo quando gli indicatori tecnici puri trovano un segnale (~10% dei cicli). In quel caso il costo reale e **~$35/mese** per 3 simboli. Vedi stima dettagliata nel flusso operativo sopra.

### Modelli Alternativi (intercambiabili)

| Modello | Input/Mt | Output/Mt | Note |
|---------|---------|----------|------|
| `anthropic/claude-3-haiku` | $0.28 | $1.4 | Piu economico in assoluto |
| `anthropic/claude-3.5-haiku` | $0.88 | $4.4 | Buon compromesso |
| `anthropic/claude-haiku-4.5` | $1.1 | $5.5 | **Default Analyst** - miglior rapporto qualita/prezzo |
| `anthropic/claude-3.5-sonnet` | $3.0 | $15 | Alternativa Strategist |
| `anthropic/claude-sonnet-4.5` | $3.0 | $15 | **Default Strategist** - ragionamento avanzato |
| `anthropic/claude-sonnet-4.6` | $3.0 | $15 | **Default Executor** - modello piu recente |
| `google/gemini-2.5-flash` | ~$0.15 | ~$0.6 | Alternativa veloce per Analyst |
| `google/gemini-2.5-pro` | ~$1.25 | ~$10 | Alternativa Strategist |
| `openai/gpt-4o` | $2.5 | $10 | Alternativa Executor |
| `openai/gpt-5-chat` | Premium | Premium | Massima qualita |
| `meta-llama/llama-3.2-90b-vision-instruct` | Economico | Economico | Open source |

### Setup WaveSpeed

1. Registrati su [wavespeed.ai](https://wavespeed.ai)
2. Vai su [API Keys](https://wavespeed.ai/accesskey) e genera una key
3. **Importante**: Effettua un top-up per attivare la key (non funziona senza credito)
4. Salva come secret: `wrangler secret put WAVESPEED_API_KEY`

### Client Base WaveSpeed (src/wavespeed/client.ts)

```typescript
/**
 * Client base WaveSpeed AI - Any LLM Gateway
 * Usato da tutti gli agenti della pipeline.
 * Docs: https://wavespeed.ai/docs/docs-api/wavespeed-ai/any-llm
 */

const WAVESPEED_API_URL =
  'https://api.wavespeed.ai/api/v3/wavespeed-ai/any-llm';

export interface WaveSpeedResponse {
  code: number;
  data: {
    id: string;
    status: string;
    outputs: string;
    timings?: { inference: number };
  };
}

export async function callWaveSpeed(
  apiKey: string,
  opts: {
    prompt: string;
    systemPrompt: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number }> {
  const res = await fetch(WAVESPEED_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: opts.prompt,
      system_prompt: opts.systemPrompt,
      model: opts.model,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      enable_sync_mode: true,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `WaveSpeed API error: ${res.status} ${await res.text()}`
    );
  }

  const result = (await res.json()) as WaveSpeedResponse;

  if (
    result.data.status !== 'completed' ||
    !result.data.outputs
  ) {
    throw new Error(`Task status: ${result.data.status}`);
  }

  return {
    text: result.data.outputs,
    inferenceMs: result.data.timings?.inference ?? 0,
  };
}

import { z, ZodSchema } from 'zod';

/** Estrai e valida JSON da una risposta testuale del LLM */
export function extractJson<T>(text: string, schema?: ZodSchema<T>): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        console.error('[Schema] Validation failed:', result.error.message);
        return null;
      }
      return result.data;
    }
    return parsed as T;
  } catch {
    return null;
  }
}
```

### Agente 1: Analyst (src/wavespeed/analyst.ts)

```typescript
import { callWaveSpeed, extractJson } from './client';
import { z } from 'zod';

export interface AnalystSignal {
  action: 'LONG' | 'SHORT' | 'HOLD';
  confidence: number;
  reasoning: string;
  keyPatterns: string[];
}

const AnalystSignalSchema = z.object({
  action: z.enum(['LONG', 'SHORT', 'HOLD']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  keyPatterns: z.array(z.string()),
});

/**
 * ANALYST - Gira quando gli indicatori tecnici trovano un segnale.
 * Modello: Haiku 4.5 (veloce, economico, intelligente).
 * Compito: analizzare indicatori e identificare pattern.
 * Skills: pattern recognition, divergenze, trend detection.
 */
export async function runAnalyst(
  apiKey: string,
  data: {
    symbol: string;
    price: number;
    rsi: number;
    ema20: number;
    ema50: number;
    macd: number;
    macdHistogram: number;
    bbUpper: number;
    bbMiddle: number;
    bbLower: number;
    recentCloses: number[];
  },
  model: string = 'anthropic/claude-haiku-4.5'
): Promise<AnalystSignal> {
  const systemPrompt = `Sei un analista tecnico crypto specializzato in pattern recognition.

## LE TUE SKILL

### SKILL 1: Trend Detection
- Identifica trend primario (EMA20 vs EMA50 cross direction)
- Valuta la forza del trend (distanza tra le EMA)
- Rileva trend esausti (EMA convergenti dopo lunga divergenza)

### SKILL 2: Momentum Analysis
- RSI: identifica zone oversold (<30) e overbought (>70)
- RSI Divergenza: prezzo fa nuovi minimi ma RSI no (bullish) o viceversa
- MACD: crossover della signal line, cambi di direzione dell'istogramma
- Momentum in esaurimento: istogramma MACD che si contrae

### SKILL 3: Volatility & Mean Reversion
- Bollinger Bands: prezzo che tocca o sfora le bande
- Squeeze: bande che si restringono (esplosione imminente)
- Mean reversion: prezzo lontano dalla media tende a tornare

### SKILL 4: Price Action
- Candele: identifica pattern nelle ultime 10 close
- Supporti/resistenze dinamici: EMA20, EMA50, BB middle
- Breakout: prezzo che supera BB upper/lower con momentum

## REGOLE
- Rispondi SOLO in JSON valido
- Se i segnali sono misti o deboli, rispondi HOLD
- confidence: 0 = nessun segnale, 1 = tutti gli indicatori allineati
- In keyPatterns elenca i pattern specifici che hai trovato`;

  const prompt = `${data.symbol} @ $${data.price}

RSI(14): ${data.rsi.toFixed(2)}
EMA20: ${data.ema20.toFixed(2)} | EMA50: ${data.ema50.toFixed(2)} | Cross: ${data.ema20 > data.ema50 ? 'BULLISH' : 'BEARISH'}
MACD: ${data.macd.toFixed(4)} | Hist: ${data.macdHistogram.toFixed(4)}
BB: L=${data.bbLower.toFixed(2)} M=${data.bbMiddle.toFixed(2)} U=${data.bbUpper.toFixed(2)}
Ultime 10 close: ${data.recentCloses.slice(-10).map((c) => c.toFixed(2)).join(', ')}

Applica le tue skill e rispondi in JSON:
{"action":"LONG|SHORT|HOLD","confidence":0-1,"reasoning":"...","keyPatterns":["..."]}`;

  try {
    const { text, inferenceMs } = await callWaveSpeed(
      apiKey,
      { prompt, systemPrompt, model, temperature: 0.2 }
    );

    console.log(
      `[Analyst] ${data.symbol}: ${inferenceMs}ms`
    );

    const result = extractJson<AnalystSignal>(text, AnalystSignalSchema);
    return result ?? {
      action: 'HOLD',
      confidence: 0,
      reasoning: 'Parse error',
      keyPatterns: [],
    };
  } catch (err) {
    console.error('[Analyst] error:', err);
    return {
      action: 'HOLD',
      confidence: 0,
      reasoning: (err as Error).message,
      keyPatterns: [],
    };
  }
}
```

### Agente 2: Strategist (src/wavespeed/strategist.ts)

```typescript
import { callWaveSpeed, extractJson } from './client';
import { AnalystSignal } from './analyst';
import { z } from 'zod';

export interface TradingPlan {
  approved: boolean;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizePercent: number; // % del balance
  riskRewardRatio: number;
  reasoning: string;
  risks: string[];
}

const TradingPlanSchema = z.object({
  approved: z.boolean(),
  direction: z.enum(['LONG', 'SHORT']),
  entryPrice: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  positionSizePercent: z.number().min(0).max(5), // hard cap 5%
  riskRewardRatio: z.number().min(0),
  reasoning: z.string(),
  risks: z.array(z.string()),
});

/**
 * STRATEGIST - Gira solo quando l'Analyst trova un segnale.
 * Modello: Sonnet 4.5 (ragionamento avanzato).
 * Compito: elaborare un piano completo con entry, SL, TP, sizing.
 * Skills: position sizing, risk management, hedging.
 */
export async function runStrategist(
  apiKey: string,
  data: {
    symbol: string;
    price: number;
    analystSignal: AnalystSignal;
    balance: number;
    openPositions: number;
    maxPositions: number;
    leverage: number;
    atr: number;
    longShortRatio: { longAccount: string; shortAccount: string }[];
  },
  model: string = 'anthropic/claude-sonnet-4.5'
): Promise<TradingPlan> {
  const systemPrompt = `Sei uno strategist di trading crypto. Ricevi un segnale dall'Analyst e devi elaborare un piano operativo completo.

## LE TUE SKILL

### SKILL 1: Position Sizing (Kelly Criterion Adattato)
- Calcola il size ottimale in base a: balance, win rate storica, R:R ratio
- Formula base: size = (balance * riskPercent) / distanza_SL
- Mai rischiare piu del 2% del balance per singolo trade
- Con leverage: effettivo_size = size * leverage, ma il rischio resta sul 2%
- Scala la size in base alla confidence dell'Analyst (conf 0.6 = 60% della size calcolata)

### SKILL 2: Stop Loss & Take Profit Dinamici
- SL basato sull'ATR: SL = entry ± (ATR * multiplier)
  - Trend forte: multiplier = 1.0 (SL stretto)
  - Trend debole/range: multiplier = 1.5-2.0 (SL largo)
- TP basato su R:R minimo 1.5:1, ideale 2:1
- TP multi-livello: TP1 = 1:1 (chiudi 50%), TP2 = 2:1 (chiudi 30%), TP3 = 3:1 (trailing)
- Mai posizionare SL su numeri tondi (es: $60000) → usa $59847

### SKILL 3: Sentiment & Crowd Analysis
- Long/Short ratio > 2.0: troppi long, rischio short squeeze → cautela su LONG
- Long/Short ratio < 0.5: troppi short, rischio squeeze → cautela su SHORT
- Contrarian: se tutti sono da una parte, valuta l'opposto
- Funding rate alto positivo: long pagano short → bias SHORT
- Funding rate alto negativo: short pagano long → bias LONG

### SKILL 4: Correlazioni & Contesto
- Se BTC scende forte, anche le alt tendono a scendere (correlazione)
- Non aprire LONG su ETH se BTC sta crollando
- Considera il numero di posizioni gia aperte (diversificazione)
- Evita di sovraccaricare nella stessa direzione

### SKILL 5: Strategie di Hedging
- Se il segnale e forte ma il contesto e incerto:
  proponi size ridotta + SL largo invece di size piena + SL stretto
- Se ci sono gia posizioni aperte nella direzione opposta:
  valuta se il nuovo trade funziona come hedge

## REGOLE
- approved=false se R:R < 1.5 o se il contesto e troppo rischioso
- Rispondi SOLO in JSON valido`;

  const prompt = `SEGNALE ANALYST:
Direction: ${data.analystSignal.action}
Confidence: ${data.analystSignal.confidence}
Patterns: ${data.analystSignal.keyPatterns.join(', ')}
Reasoning: ${data.analystSignal.reasoning}

CONTESTO:
Symbol: ${data.symbol} @ $${data.price}
ATR(14): ${data.atr.toFixed(2)}
Balance: $${data.balance.toFixed(2)}
Posizioni aperte: ${data.openPositions}/${data.maxPositions}
Leva: ${data.leverage}x
L/S Ratio: ${data.longShortRatio.slice(0, 3).map((r) => `L:${r.longAccount} S:${r.shortAccount}`).join(' | ')}

Elabora il piano in JSON:
{
  "approved": boolean,
  "direction": "LONG" | "SHORT",
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit": number,
  "positionSizePercent": number,
  "riskRewardRatio": number,
  "reasoning": "...",
  "risks": ["..."]
}`;

  try {
    const { text, inferenceMs } = await callWaveSpeed(
      apiKey,
      { prompt, systemPrompt, model, temperature: 0.3 }
    );

    console.log(
      `[Strategist] ${data.symbol}: ${inferenceMs}ms`
    );

    const result = extractJson<TradingPlan>(text, TradingPlanSchema);
    return result ?? {
      approved: false,
      direction: data.analystSignal.action as 'LONG' | 'SHORT',
      entryPrice: data.price,
      stopLoss: 0,
      takeProfit: 0,
      positionSizePercent: 0,
      riskRewardRatio: 0,
      reasoning: 'Parse error',
      risks: ['Failed to parse strategist response'],
    };
  } catch (err) {
    console.error('[Strategist] error:', err);
    return {
      approved: false,
      direction: data.analystSignal.action as 'LONG' | 'SHORT',
      entryPrice: data.price,
      stopLoss: 0,
      takeProfit: 0,
      positionSizePercent: 0,
      riskRewardRatio: 0,
      reasoning: (err as Error).message,
      risks: ['Strategist error'],
    };
  }
}
```

### Agente 3: Executor (src/wavespeed/executor.ts)

```typescript
import { callWaveSpeed, extractJson } from './client';
import { AnalystSignal } from './analyst';
import { TradingPlan } from './strategist';
import { z } from 'zod';

export interface ExecutorDecision {
  execute: boolean;
  adjustedStopLoss?: number;
  adjustedTakeProfit?: number;
  adjustedSize?: number;
  reasoning: string;
  urgency: 'immediate' | 'wait_for_dip' | 'cancel';
}

const ExecutorDecisionSchema = z.object({
  execute: z.boolean(),
  adjustedStopLoss: z.number().positive().optional(),
  adjustedTakeProfit: z.number().positive().optional(),
  adjustedSize: z.number().min(0).max(100).optional(),
  reasoning: z.string(),
  urgency: z.enum(['immediate', 'wait_for_dip', 'cancel']),
});

/**
 * EXECUTOR - Gira solo quando lo Strategist approva il piano.
 * Modello: Sonnet 4.6 (il piu recente e capace).
 * Compito: validazione finale, ultima linea di difesa.
 * Skills: circuit breaker, tilt detection, coherence check.
 */
export async function runExecutor(
  apiKey: string,
  data: {
    symbol: string;
    price: number;
    analystSignal: AnalystSignal;
    tradingPlan: TradingPlan;
    recentTrades: {
      pnl: number;
      direction: string;
      symbol: string;
    }[];
    dailyPnl: number;
    maxDailyLoss: number;
  },
  model: string = 'anthropic/claude-sonnet-4.6'
): Promise<ExecutorDecision> {
  const systemPrompt = `Sei l'Executor: ultima linea di difesa prima di piazzare un ordine crypto con soldi reali.

## PRIORITA ASSOLUTA: PROTEZIONE DEL CAPITALE

## LE TUE SKILL

### SKILL 1: Circuit Breaker
- BLOCCA se daily loss > 80% del maxDailyLoss
- BLOCCA se ci sono 3+ perdite consecutive (losing streak)
- BLOCCA se la somma delle ultime 3 perdite > 50% del maxDailyLoss
- BLOCCA se sono state aperte troppe posizioni oggi (overtrading)
- In caso di dubbio: BLOCCA. E sempre meglio perdere un'opportunita che perdere capitale.

### SKILL 2: Tilt Detection
- Rileva pattern di tilt emotivo nei trade recenti:
  - Perdite crescenti (size o frequenza in aumento dopo loss)
  - Trade nella stessa direzione dopo una loss sullo stesso simbolo (revenge trading)
  - Trade ravvicinati nel tempo dopo una perdita
- Se rilevi tilt: BLOCCA e suggerisci cooldown

### SKILL 3: Coherence Check
- Verifica che il piano dello Strategist sia coerente con l'analisi dell'Analyst
- L'Analyst dice LONG ma lo Strategist propone parametri che non hanno senso? BLOCCA
- Il R:R dichiarato corrisponde ai numeri reali (entry, SL, TP)? Verifica
- La size e coerente con il rischio dichiarato?

### SKILL 4: Timing & Urgency
- "immediate": il prezzo e al punto di entry, esegui ora
- "wait_for_dip": il segnale e valido ma il prezzo non e ottimale, aspetta
- "cancel": qualcosa non va, non eseguire

### SKILL 5: Aggiustamenti Finali
- Puoi aggiustare SL, TP o size se trovi incoerenze nei numeri
- Non puoi cambiare la direzione (LONG/SHORT) - per quello serve un nuovo ciclo
- Se aggiusti, spiega perche nel reasoning

## REGOLE
- In caso di errore tecnico: BLOCCA (fail-safe)
- Mai eseguire se non sei sicuro al 100%
- Rispondi SOLO in JSON valido`;

  const prompt = `ANALISI:
${data.analystSignal.reasoning}
Patterns: ${data.analystSignal.keyPatterns.join(', ')}
Confidence: ${data.analystSignal.confidence}

PIANO:
${data.tradingPlan.direction} ${data.symbol} @ $${data.tradingPlan.entryPrice}
SL: $${data.tradingPlan.stopLoss} | TP: $${data.tradingPlan.takeProfit}
R:R = ${data.tradingPlan.riskRewardRatio}
Size: ${data.tradingPlan.positionSizePercent}% del balance
Rischi: ${data.tradingPlan.risks.join('; ')}

CONTESTO RISCHIO:
P&L oggi: $${data.dailyPnl.toFixed(2)} (max loss: $${data.maxDailyLoss})
Ultimi 5 trade: ${data.recentTrades.slice(-5).map((t) => `${t.direction} ${t.symbol} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`).join(' | ') || 'Nessuno'}

Prezzo attuale: $${data.price}

JSON:
{
  "execute": boolean,
  "adjustedStopLoss": number | null,
  "adjustedTakeProfit": number | null,
  "adjustedSize": number | null,
  "reasoning": "...",
  "urgency": "immediate" | "wait_for_dip" | "cancel"
}`;

  try {
    const { text, inferenceMs } = await callWaveSpeed(
      apiKey,
      { prompt, systemPrompt, model, temperature: 0.1 }
    );

    console.log(
      `[Executor] ${data.symbol}: ${inferenceMs}ms`
    );

    const result = extractJson<ExecutorDecision>(text, ExecutorDecisionSchema);
    return result ?? {
      execute: false,
      reasoning: 'Parse error - blocking trade for safety',
      urgency: 'cancel',
    };
  } catch (err) {
    console.error('[Executor] error:', err);
    // In caso di errore, NON eseguire (fail-safe)
    return {
      execute: false,
      reasoning: `Error: ${(err as Error).message}`,
      urgency: 'cancel',
    };
  }
}
```

### API WaveSpeed - Riferimento Rapido

```bash
# Esempio chiamata diretta (per test)
curl -X POST "https://api.wavespeed.ai/api/v3/wavespeed-ai/any-llm" \
  -H "Authorization: Bearer YOUR_WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "BTC RSI is 28, EMA20 crossed above EMA50, MACD bullish. Should I go LONG or SHORT? Reply JSON only.",
    "system_prompt": "You are a crypto trading analyst. Reply only in valid JSON.",
    "model": "google/gemini-2.5-flash",
    "temperature": 0.3,
    "enable_sync_mode": true
  }'
```

### Vantaggi della Pipeline Multi-Agente

- **Separazione di responsabilita**: ogni agente ha un compito preciso e un prompt ottimizzato
- **Costo scalabile**: il 90% dei cicli usa solo Gemini Flash (~$0.002), modelli costosi solo quando serve
- **Fail-safe**: l'Executor blocca il trade in caso di errore (default: non eseguire)
- **Modelli intercambiabili**: cambia modello per agente senza toccare la logica
- **Logging granulare**: ogni agente logga reasoning e tempi, utile per debugging e ottimizzazione
- **Nessun SDK**: tutto via `fetch()`, perfetto per Cloudflare Workers

---

## 7. Engine di Trading (Long & Short)

### Indicatori Tecnici (src/utils/indicators.ts)

```typescript
/** Calcola RSI (Relative Strength Index) */
export function calculateRSI(
  closes: number[],
  period: number = 14
): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Calcola EMA (Exponential Moving Average) */
export function calculateEMA(
  data: number[],
  period: number
): number[] {
  const multiplier = 2 / (period + 1);
  const ema: number[] = [data[0]];

  for (let i = 1; i < data.length; i++) {
    ema.push((data[i] - ema[i - 1]) * multiplier + ema[i - 1]);
  }

  return ema;
}

/** Calcola MACD */
export function calculateMACD(closes: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);

  const last = macdLine.length - 1;
  return {
    macd: macdLine[last],
    signal: signalLine[last],
    histogram: macdLine[last] - signalLine[last],
  };
}

/** Calcola Bollinger Bands */
export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number; middle: number; lower: number } {
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((sum, val) => sum + (val - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std,
  };
}

/** Average True Range per calcolo dinamico SL/TP */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number {
  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const highLow = highs[i] - lows[i];
    const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
    const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}
```

### Generatore Segnali (src/trading/signals.ts)

```typescript
import {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
} from '../utils/indicators';

export interface TradingSignal {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number; // 0.0 - 1.0
  action: 'OPEN' | 'CLOSE' | 'HOLD';
  indicators: Record<string, string>;
  stopLoss: number;
  takeProfit: number;
}

export function generateSignal(
  highs: number[],
  lows: number[],
  closes: number[],
  currentPrice: number
): TradingSignal {
  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);

  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  let longScore = 0;
  let shortScore = 0;
  const indicators: Record<string, string> = {};

  // --- RSI ---
  indicators['RSI'] = rsi.toFixed(2);
  if (rsi < 30) {
    longScore += 2;
    indicators['RSI_signal'] = 'OVERSOLD -> LONG';
  } else if (rsi < 40) {
    longScore += 1;
    indicators['RSI_signal'] = 'Approaching oversold';
  } else if (rsi > 70) {
    shortScore += 2;
    indicators['RSI_signal'] = 'OVERBOUGHT -> SHORT';
  } else if (rsi > 60) {
    shortScore += 1;
    indicators['RSI_signal'] = 'Approaching overbought';
  } else {
    indicators['RSI_signal'] = 'Neutral';
  }

  // --- EMA Cross ---
  const emaCross = lastEma20 > lastEma50;
  indicators['EMA'] = `EMA20: ${lastEma20.toFixed(2)} | EMA50: ${lastEma50.toFixed(2)}`;
  if (emaCross) {
    longScore += 1.5;
    indicators['EMA_signal'] = 'Bullish cross';
  } else {
    shortScore += 1.5;
    indicators['EMA_signal'] = 'Bearish cross';
  }

  // --- MACD ---
  indicators['MACD'] = `${macd.macd.toFixed(4)} (Hist: ${macd.histogram.toFixed(4)})`;
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    longScore += 1.5;
    indicators['MACD_signal'] = 'Bullish momentum';
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    shortScore += 1.5;
    indicators['MACD_signal'] = 'Bearish momentum';
  } else {
    indicators['MACD_signal'] = 'Transitioning';
  }

  // --- Bollinger Bands ---
  indicators['BB'] = `U: ${bb.upper.toFixed(2)} | M: ${bb.middle.toFixed(2)} | L: ${bb.lower.toFixed(2)}`;
  if (currentPrice <= bb.lower) {
    longScore += 2;
    indicators['BB_signal'] = 'Price at lower band -> LONG';
  } else if (currentPrice >= bb.upper) {
    shortScore += 2;
    indicators['BB_signal'] = 'Price at upper band -> SHORT';
  } else {
    indicators['BB_signal'] = 'Within bands';
  }

  // --- Calcola direzione e forza ---
  const maxScore = 7;
  const netScore = longScore - shortScore;

  let direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  let strength: number;
  let action: 'OPEN' | 'CLOSE' | 'HOLD';

  if (netScore > 1.5) {
    direction = 'LONG';
    strength = Math.min(longScore / maxScore, 1);
    action = strength > 0.5 ? 'OPEN' : 'HOLD';
  } else if (netScore < -1.5) {
    direction = 'SHORT';
    strength = Math.min(shortScore / maxScore, 1);
    action = strength > 0.5 ? 'OPEN' : 'HOLD';
  } else {
    direction = 'NEUTRAL';
    strength = 0;
    action = 'HOLD';
  }

  // --- Stop Loss e Take Profit ---
  const atr = calculateATR(highs, lows, closes, 14);
  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'LONG') {
    stopLoss = currentPrice - atr * 1.5;
    takeProfit = currentPrice + atr * 3; // RR 1:2
  } else if (direction === 'SHORT') {
    stopLoss = currentPrice + atr * 1.5;
    takeProfit = currentPrice - atr * 3;
  } else {
    stopLoss = 0;
    takeProfit = 0;
  }

  return {
    direction,
    strength,
    action,
    indicators,
    stopLoss,
    takeProfit,
  };
}
```

### Engine Principale (src/trading/engine.ts)

```typescript
import { BinanceFuturesClient } from '../binance/client';
import { TelegramBot } from '../telegram/bot';
import { runAnalyst, AnalystSignal } from '../wavespeed/analyst';
import { runStrategist, TradingPlan } from '../wavespeed/strategist';
import { runExecutor, ExecutorDecision } from '../wavespeed/executor';
import { generateSignal, TradingSignal } from './signals';
import { RiskManager, RiskConfig } from './risk';

interface TradingConfig {
  symbols: string[];           // Es: ['BTCUSDT', 'ETHUSDT']
  maxPositions: number;        // Max posizioni simultanee
  maxPositionSizeUsdt: number; // Max size per posizione in USDT
  leverage: number;            // Leva (1-20 consigliato)
  useLlmPipeline: boolean;     // Abilita pipeline multi-agente
  analystModel: string;        // Modello per Analyst
  strategistModel: string;     // Modello per Strategist
  executorModel: string;       // Modello per Executor
  minSignalStrength: number;   // Forza minima segnale (0.5)
  riskPerTrade: number;        // % del balance per trade (1-2%)
}

export class TradingEngine {
  private binance: BinanceFuturesClient;
  private telegram: TelegramBot;
  private wavespeedKey: string | null;
  private config: TradingConfig;
  private risk: RiskManager;

  constructor(
    binance: BinanceFuturesClient,
    telegram: TelegramBot,
    wavespeedKey: string | null,
    config: TradingConfig,
    riskConfig: RiskConfig
  ) {
    this.binance = binance;
    this.telegram = telegram;
    this.wavespeedKey = wavespeedKey;
    this.config = config;
    this.risk = new RiskManager(riskConfig);
  }

  /** Ciclo principale - chiamato dal cron trigger */
  async run(db: D1Database): Promise<void> {
    for (const symbol of this.config.symbols) {
      try {
        await this.processSymbol(symbol, db);
      } catch (error) {
        const errMsg = (error as Error).message?.slice(0, 100) || 'unknown error';
        console.error(`Error processing ${symbol}:`, error);
        await this.telegram.sendMessage(
          `⚠️ Errore su ${symbol}: ${errMsg}`
        );
      }
    }
  }

  private async processSymbol(
    symbol: string,
    db: D1Database
  ): Promise<void> {
    // ========================================
    // FASE 1: COLLECTOR (no LLM, puro fetch)
    // ========================================
    const [price, klines, account] = await Promise.all([
      this.binance.getPrice(symbol),
      this.binance.getKlines(symbol, '15m', 100),
      this.binance.getAccountInfo(),
    ]);

    // Risk check prima di qualsiasi LLM call
    const balance = parseFloat(account.availableBalance);
    const riskCheck = await this.risk.canTrade(db, balance);
    if (!riskCheck.allowed) {
      console.log(
        `[Risk] Trading bloccato per ${symbol}: ${riskCheck.reason}`
      );
      return;
    }

    const highs = klines.map(
      (k: number[]) => parseFloat(k[2] as unknown as string)
    );
    const lows = klines.map(
      (k: number[]) => parseFloat(k[3] as unknown as string)
    );
    const closes = klines.map(
      (k: number[]) => parseFloat(k[4] as unknown as string)
    );

    // Calcola indicatori tecnici (puro codice)
    const signal = generateSignal(highs, lows, closes, price);

    // Controlla posizioni esistenti
    const openPositions = account.positions.filter(
      (p) => parseFloat(p.positionAmt) !== 0
    );
    const symbolPosition = openPositions.find(
      (p) => p.symbol === symbol
    );
    const totalOpenPositions = openPositions.length;

    // Se c'e un segnale opposto alla posizione aperta -> chiudi
    if (symbolPosition) {
      const currentSide =
        parseFloat(symbolPosition.positionAmt) > 0 ? 'LONG' : 'SHORT';
      if (
        (currentSide === 'LONG' && signal.direction === 'SHORT') ||
        (currentSide === 'SHORT' && signal.direction === 'LONG')
      ) {
        await this.closePosition(symbol, symbolPosition, price, db);
      }
      return;
    }

    // ========================================
    // Fix 8: Duplicate trade protection
    // ========================================
    // Check D1 for existing PENDING orders on the same symbol
    const pendingCount = await db
      .prepare(
        `SELECT COUNT(*) as count FROM trades
         WHERE symbol = ? AND status = 'PENDING'`
      )
      .bind(symbol)
      .first();

    if ((pendingCount?.count as number) > 0) {
      console.log(
        `[DupCheck] Skipping ${symbol}: already has PENDING order`
      );
      return;
    }

    // Check for OPEN trades on the same symbol AND same direction
    // (avoid opening a second LONG when one LONG is already open)
    if (signal.direction !== 'NEUTRAL') {
      const openSameDirection = await db
        .prepare(
          `SELECT COUNT(*) as count FROM trades
           WHERE symbol = ? AND status = 'OPEN'
             AND position_side = ?`
        )
        .bind(symbol, signal.direction)
        .first();

      if ((openSameDirection?.count as number) > 0) {
        console.log(
          `[DupCheck] Skipping ${symbol}: already has OPEN ` +
            `${signal.direction} position`
        );
        return;
      }
    }

    // Se nessun segnale tecnico forte, stop qui (senza usare LLM)
    if (
      signal.action !== 'OPEN' ||
      signal.strength < this.config.minSignalStrength ||
      totalOpenPositions >= this.config.maxPositions
    ) {
      await this.logSignal(db, symbol, signal, false);
      return;
    }

    // ========================================
    // FASE 2: ANALYST (Gemini Flash)
    // ========================================
    if (this.config.useLlmPipeline && this.wavespeedKey) {
      const rsi = parseFloat(signal.indicators['RSI']);
      const ema20 = parseFloat(
        signal.indicators['EMA'].split('|')[0].split(':')[1]
      );
      const ema50 = parseFloat(
        signal.indicators['EMA'].split('|')[1].split(':')[1]
      );
      const macd = parseFloat(
        signal.indicators['MACD'].split('(')[0]
      );
      const macdHist = parseFloat(
        signal.indicators['MACD'].match(
          /Hist: ([-\d.]+)/
        )?.[1] || '0'
      );
      const bb = signal.indicators['BB'].split('|');

      const analystResult = await runAnalyst(
        this.wavespeedKey,
        {
          symbol,
          price,
          rsi,
          ema20,
          ema50,
          macd,
          macdHistogram: macdHist,
          bbUpper: parseFloat(bb[0].split(':')[1]),
          bbMiddle: parseFloat(bb[1].split(':')[1]),
          bbLower: parseFloat(bb[2].split(':')[1]),
          recentCloses: closes.slice(-20),
        },
        this.config.analystModel
      );

      // Se l'Analyst dice HOLD o bassa confidence -> stop
      if (
        analystResult.action === 'HOLD' ||
        analystResult.confidence < 0.6
      ) {
        console.log(
          `[Analyst] HOLD for ${symbol} ` +
            `(confidence: ${analystResult.confidence})`
        );
        await this.logSignal(db, symbol, signal, false);
        return;
      }

      // ========================================
      // FASE 3: STRATEGIST (Gemini Pro)
      // ========================================
      const longShortRatio =
        await this.binance.getLongShortRatio(symbol);
      const balance = parseFloat(account.availableBalance);
      const atr = parseFloat(
        signal.indicators['ATR'] || '0'
      ) || (signal.stopLoss
        ? Math.abs(price - signal.stopLoss) / 1.5
        : price * 0.01);

      const plan = await runStrategist(
        this.wavespeedKey,
        {
          symbol,
          price,
          analystSignal: analystResult,
          balance,
          openPositions: totalOpenPositions,
          maxPositions: this.config.maxPositions,
          leverage: this.config.leverage,
          atr,
          longShortRatio,
        },
        this.config.strategistModel
      );

      // Se lo Strategist non approva -> stop
      if (!plan.approved || plan.riskRewardRatio < 1.5) {
        console.log(
          `[Strategist] REJECTED for ${symbol} ` +
            `(R:R = ${plan.riskRewardRatio})`
        );
        await this.logSignal(db, symbol, signal, false);
        return;
      }

      // ========================================
      // FASE 4: EXECUTOR (Sonnet 4.6)
      // ========================================
      const recentTrades = await db
        .prepare(
          `SELECT pnl, position_side as direction, symbol
           FROM trades WHERE status = 'CLOSED'
           ORDER BY closed_at DESC LIMIT 5`
        )
        .all();

      const dailyPnlResult = await db
        .prepare(
          `SELECT COALESCE(SUM(pnl), 0) as total
           FROM trades
           WHERE date(closed_at) = date('now')
             AND status = 'CLOSED'`
        )
        .first();

      const decision = await runExecutor(
        this.wavespeedKey,
        {
          symbol,
          price,
          analystSignal: analystResult,
          tradingPlan: plan,
          recentTrades: (recentTrades.results || []) as any[],
          dailyPnl: (dailyPnlResult?.total as number) || 0,
          maxDailyLoss: this.config.maxPositionSizeUsdt * 0.1,
        },
        this.config.executorModel
      );

      // Se l'Executor blocca -> stop
      if (!decision.execute || decision.urgency === 'cancel') {
        console.log(
          `[Executor] BLOCKED for ${symbol}: ` +
            decision.reasoning
        );
        await this.logSignal(db, symbol, signal, false);
        return;
      }

      // Usa i parametri del piano (con eventuali aggiustamenti)
      signal.stopLoss =
        decision.adjustedStopLoss ?? plan.stopLoss;
      signal.takeProfit =
        decision.adjustedTakeProfit ?? plan.takeProfit;
    }

    // ========================================
    // ESECUZIONE ORDINE
    // ========================================
    await this.openPosition(symbol, signal, price, account, db);
    await this.logSignal(db, symbol, signal, true);
  }

  /** Salva segnale in D1 */
  private async logSignal(
    db: D1Database,
    symbol: string,
    signal: TradingSignal,
    executed: boolean
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO signals
           (symbol, direction, strength, indicators, action, executed)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        symbol,
        signal.direction,
        signal.strength,
        JSON.stringify(signal.indicators),
        signal.action,
        executed ? 1 : 0
      )
      .run();
  }

  /**
   * Apri una nuova posizione Long o Short.
   *
   * Strategia ordini:
   *   1. LIMIT (GTC) - apertura posizione al prezzo target
   *      Prezzo leggermente aggressivo (+/- 0.05%) per favorire il fill.
   *      Maker fee = 0.02% (meta del taker 0.04%).
   *   2. STOP_MARKET - stop loss (via Algo API, resta su Binance)
   *   3. TAKE_PROFIT_MARKET - take profit (via Algo API, resta su Binance)
   *
   * Il LIMIT potrebbe non fillare subito. Il cron successivo controlla:
   *   - Se fillato → SL/TP gia piazzati, tutto ok
   *   - Se non fillato dopo N cicli → cancella e rianalizza
   *
   * SL e TP restano attivi su Binance anche se il bot va offline.
   */
  private async openPosition(
    symbol: string,
    signal: TradingSignal,
    price: number,
    account: any,
    db: D1Database
  ): Promise<void> {
    const balance = parseFloat(account.availableBalance);
    const positionSize = this.risk.calculatePositionSize(
      balance,
      this.config.riskPerTrade,
      price,
      signal.stopLoss,
      this.config.leverage
    );
    // Fix 7: Fetch symbol precision and use dynamic rounding
    await this.binance.getSymbolInfo(symbol);
    const quantity = this.binance.roundQuantity(
      symbol,
      positionSize / price
    );

    // Imposta leva
    await this.binance.setLeverage(symbol, this.config.leverage);

    // Determina side dell'ordine
    // In Hedge Mode:
    //   LONG  -> side: BUY,  positionSide: LONG
    //   SHORT -> side: SELL, positionSide: SHORT
    const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const closeSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
    const positionSide = signal.direction;

    // ============================
    // ORDINE 1: LIMIT (apertura)
    // ============================
    // Prezzo leggermente aggressivo per favorire il fill:
    //   LONG  → prezzo un po' sopra il mercato (pago un pelo di piu)
    //   SHORT → prezzo un po' sotto il mercato (vendo un pelo meno)
    // 0.05% di tolleranza = buon compromesso tra fill rate e slippage
    const ENTRY_TOLERANCE = 0.0005; // 0.05%
    const limitPrice =
      signal.direction === 'LONG'
        ? price * (1 + ENTRY_TOLERANCE)
        : price * (1 - ENTRY_TOLERANCE);

    // Fix 7: Arrotonda al tick size dinamico per il simbolo
    const roundedPrice = this.binance.roundPrice(symbol, limitPrice);

    const order = await this.binance.newOrder({
      symbol,
      side: side as 'BUY' | 'SELL',
      positionSide: positionSide as 'LONG' | 'SHORT',
      type: 'LIMIT',
      quantity,
      price: roundedPrice,
      timeInForce: 'GTC', // Good Till Cancel
    });

    console.log(
      `[Order] LIMIT ${side} ${symbol} qty=${quantity} ` +
        `price=$${roundedPrice} orderId=${order.orderId}`
    );

    // ============================
    // ORDINE 2: STOP LOSS (Algo API)
    // ============================
    // Nota: piazziamo SL/TP subito. Se il LIMIT non filla,
    // SL/TP resteranno inattivi (non c'e posizione da chiudere).
    // Verranno cancellati se il LIMIT viene cancellato.
    let slAlgoId = '';
    let slFailed = false; // Fix 6: track SL placement failure
    if (signal.stopLoss > 0) {
      try {
        const slOrder = await this.binance.newAlgoOrder({
          symbol,
          side: closeSide as 'BUY' | 'SELL',
          positionSide: positionSide as 'LONG' | 'SHORT',
          type: 'STOP_MARKET',
          triggerPrice: signal.stopLoss,
          closePosition: true,
        });

        slAlgoId = slOrder.algoId?.toString() || '';
        console.log(
          `[Order] SL STOP_MARKET ${closeSide} ${symbol} ` +
            `trigger=$${signal.stopLoss} algoId=${slAlgoId}`
        );
      } catch (err) {
        console.error('[Order] SL failed:', err);
        slFailed = true;
        await this.telegram.sendMessage(
          `⚠️ SL non piazzato per ${symbol}: ${(err as Error).message}`
        );
      }
    } else {
      // No stop loss price provided - treat as failure
      slFailed = true;
    }

    // ============================
    // ORDINE 3: TAKE PROFIT (Algo API)
    // ============================
    let tpAlgoId = '';
    if (signal.takeProfit > 0) {
      try {
        const tpOrder = await this.binance.newAlgoOrder({
          symbol,
          side: closeSide as 'BUY' | 'SELL',
          positionSide: positionSide as 'LONG' | 'SHORT',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: signal.takeProfit,
          closePosition: true,
        });

        tpAlgoId = tpOrder.algoId?.toString() || '';
        console.log(
          `[Order] TP TAKE_PROFIT_MARKET ${closeSide} ${symbol} ` +
            `trigger=$${signal.takeProfit} algoId=${tpAlgoId}`
        );
      } catch (err) {
        console.error('[Order] TP failed:', err);
        await this.telegram.sendMessage(
          `⚠️ TP non piazzato per ${symbol}: ${(err as Error).message}`
        );
      }
    }

    // ============================
    // SAFETY: No trade without stop loss protection (Fix 6)
    // ============================
    // If the SL failed to be placed, we must not leave a position
    // unprotected. Cancel the LIMIT if still pending, or close
    // with MARKET if already filled.
    if (slFailed) {
      console.error(
        `[SAFETY] SL failed for ${symbol} - aborting position`
      );

      // Check if the LIMIT order has already been filled
      const openOrders = await this.binance.getOpenOrders(symbol);
      const limitStillOpen = openOrders.some(
        (o: any) => o.orderId?.toString() === order.orderId?.toString()
      );

      if (limitStillOpen) {
        // LIMIT not yet filled - cancel it
        await this.binance.cancelOrder(
          symbol,
          order.orderId?.toString()
        );
        console.log(
          `[SAFETY] Cancelled unfilled LIMIT for ${symbol}`
        );
      } else {
        // LIMIT already filled - close with MARKET immediately
        await this.binance.newOrder({
          symbol,
          side: closeSide as 'BUY' | 'SELL',
          positionSide: positionSide as 'LONG' | 'SHORT',
          type: 'MARKET',
          quantity,
        });
        console.log(
          `[SAFETY] Closed filled position with MARKET for ${symbol}`
        );
      }

      // Cancel the TP algo order if it was placed
      if (tpAlgoId) {
        await this.binance.cancelAlgoOrder(symbol, tpAlgoId)
          .catch(() => {});
      }

      await this.telegram.sendMessage(
        `🚨 SAFETY: Posizione ${symbol} annullata - impossibile piazzare SL. ` +
          `Nessun trade senza stop loss.`
      );
      return; // Do not save trade to D1 - it has been aborted
    }

    // Notifica Telegram
    await this.telegram.notifyTradeOpen({
      symbol,
      side,
      positionSide,
      quantity,
      price: roundedPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      leverage: this.config.leverage,
    });

    // Salva in D1 con status PENDING (LIMIT non ancora fillato)
    await db
      .prepare(
        `INSERT INTO trades
           (symbol, side, position_side, type, quantity, price,
            stop_loss, take_profit, status, binance_order_id,
            signal_source, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        symbol,
        side,
        positionSide,
        'LIMIT',
        quantity,
        roundedPrice,
        signal.stopLoss,
        signal.takeProfit,
        'PENDING', // Diventa OPEN quando il LIMIT filla
        order.orderId?.toString() || '',
        'llm',
        JSON.stringify({ slAlgoId, tpAlgoId })
      )
      .run();
  }

  /**
   * Controlla ordini LIMIT pendenti.
   * Chiamato dal cron ad ogni ciclo.
   * - Se fillato → aggiorna status a OPEN
   * - Se non fillato dopo maxPendingCycles → cancella tutto
   */
  async checkPendingOrders(db: D1Database): Promise<void> {
    const pending = await db
      .prepare(
        `SELECT * FROM trades WHERE status = 'PENDING'`
      )
      .all();

    for (const trade of pending.results || []) {
      const orderId = trade.binance_order_id as string;
      if (!orderId) continue;

      try {
        // Controlla stato ordine su Binance
        const orderStatus = await this.binance.getOpenOrders(
          trade.symbol as string
        );

        const isStillOpen = orderStatus.some(
          (o: any) => o.orderId?.toString() === orderId
        );

        if (!isStillOpen) {
          // Ordine non piu tra gli aperti → e stato fillato
          // (oppure cancellato esternamente)
          const account = await this.binance.getAccountInfo();
          const position = account.positions.find(
            (p: any) =>
              p.symbol === trade.symbol &&
              parseFloat(p.positionAmt) !== 0
          );

          if (position) {
            // Fillato! Aggiorna a OPEN
            await db
              .prepare(
                `UPDATE trades SET status = 'OPEN'
                 WHERE id = ?`
              )
              .bind(trade.id)
              .run();

            console.log(
              `[Pending] ${trade.symbol} LIMIT filled → OPEN`
            );
          } else {
            // Cancellato o expired, pulisci
            await this.cancelTradeOrders(
              trade.symbol as string,
              trade.notes as string
            );

            await db
              .prepare(
                `UPDATE trades SET status = 'CANCELLED'
                 WHERE id = ?`
              )
              .bind(trade.id)
              .run();

            console.log(
              `[Pending] ${trade.symbol} LIMIT not filled → CANCELLED`
            );
          }
        } else {
          // Ancora aperto - controlla da quanto tempo
          const openedAt = new Date(
            trade.opened_at as string
          ).getTime();
          const elapsed = Date.now() - openedAt;
          const MAX_PENDING_MS = 10 * 60 * 1000; // 10 minuti

          if (elapsed > MAX_PENDING_MS) {
            // Troppo tempo → cancella
            await this.binance.cancelOrder(
              trade.symbol as string,
              orderId
            );
            await this.cancelTradeOrders(
              trade.symbol as string,
              trade.notes as string
            );

            await db
              .prepare(
                `UPDATE trades SET status = 'CANCELLED'
                 WHERE id = ?`
              )
              .bind(trade.id)
              .run();

            console.log(
              `[Pending] ${trade.symbol} LIMIT expired ` +
                `after ${(elapsed / 60000).toFixed(0)}min → CANCELLED`
            );

            await this.telegram.sendMessage(
              `⏰ Ordine LIMIT ${trade.symbol} cancellato ` +
                `(non fillato in 10 min)`
            );
          }
        }
      } catch (err) {
        console.error(
          `[Pending] Error checking ${trade.symbol}:`,
          err
        );
      }
    }
  }

  /** Cancella ordini SL/TP associati a un trade */
  private async cancelTradeOrders(
    symbol: string,
    notesJson: string
  ): Promise<void> {
    if (!notesJson) return;
    try {
      const { slAlgoId, tpAlgoId } = JSON.parse(notesJson);
      if (slAlgoId) {
        await this.binance
          .cancelAlgoOrder(symbol, slAlgoId)
          .catch(() => {});
      }
      if (tpAlgoId) {
        await this.binance
          .cancelAlgoOrder(symbol, tpAlgoId)
          .catch(() => {});
      }
    } catch {
      // parse error, ignora
    }
  }

  /**
   * Chiudi una posizione esistente.
   * Cancella anche gli ordini SL/TP condizionali rimasti su Binance.
   */
  private async closePosition(
    symbol: string,
    position: any,
    currentPrice: number,
    db: D1Database
  ): Promise<void> {
    const posAmt = parseFloat(position.positionAmt);
    const isLong = posAmt > 0;
    const quantity = Math.abs(posAmt);

    const side = isLong ? 'SELL' : 'BUY';
    const positionSide = isLong ? 'LONG' : 'SHORT';

    // 1. Chiudi posizione con ordine MARKET
    await this.binance.newOrder({
      symbol,
      side: side as 'BUY' | 'SELL',
      positionSide: positionSide as 'LONG' | 'SHORT',
      type: 'MARKET',
      quantity,
    });

    // 2. Cancella ordini SL/TP rimasti (altrimenti restano orfani)
    const trade = await db
      .prepare(
        `SELECT notes FROM trades
         WHERE symbol = ? AND position_side = ?
           AND status = 'OPEN'`
      )
      .bind(symbol, positionSide)
      .first();

    if (trade?.notes) {
      await this.cancelTradeOrders(
        symbol,
        trade.notes as string
      );
    }

    // 3. Calcola P&L
    const entryPrice = parseFloat(position.entryPrice);
    const pnl = isLong
      ? (currentPrice - entryPrice) * quantity
      : (entryPrice - currentPrice) * quantity;
    const pnlPercent = (pnl / (entryPrice * quantity)) * 100;

    // 4. Notifica Telegram
    await this.telegram.notifyTradeClose({
      symbol,
      positionSide,
      entryPrice,
      exitPrice: currentPrice,
      pnl,
      pnlPercent,
    });

    // 5. Aggiorna D1
    await db
      .prepare(
        `UPDATE trades
         SET status = 'CLOSED', pnl = ?, closed_at = datetime('now')
         WHERE symbol = ? AND position_side = ? AND status = 'OPEN'`
      )
      .bind(pnl, symbol, positionSide)
      .run();
  }

  /**
   * Sincronizza le posizioni del DB con lo stato reale su Binance.
   * Se una posizione risulta OPEN in D1 ma non esiste piu su Binance
   * (chiusa da SL/TP), aggiorna D1 a CLOSED e stima il P&L.
   */
  async syncPositions(db: D1Database): Promise<void> {
    try {
      // 1. Fetch posizioni reali da Binance
      const account = await this.binance.getAccountInfo();
      const binancePositions = account.positions.filter(
        (p) => parseFloat(p.positionAmt) !== 0
      );

      // 2. Query D1 per tutte le posizioni OPEN
      const openTrades = await db
        .prepare(
          `SELECT * FROM trades WHERE status = 'OPEN'`
        )
        .all();

      for (const trade of openTrades.results || []) {
        const symbol = trade.symbol as string;
        const positionSide = trade.position_side as string;

        // 3. Cerca posizione corrispondente su Binance
        const matchingPosition = binancePositions.find(
          (p) =>
            p.symbol === symbol &&
            p.positionSide === positionSide &&
            parseFloat(p.positionAmt) !== 0
        );

        // 4. Se NON esiste su Binance -> chiusa da SL/TP
        if (!matchingPosition) {
          const entryPrice = trade.price as number;
          const quantity = trade.quantity as number;

          // Stima P&L usando il prezzo corrente come proxy
          const currentPrice = await this.binance.getPrice(symbol);
          const isLong = positionSide === 'LONG';
          const estimatedPnl = isLong
            ? (currentPrice - entryPrice) * quantity
            : (entryPrice - currentPrice) * quantity;

          await db
            .prepare(
              `UPDATE trades
               SET status = 'CLOSED',
                   pnl = ?,
                   closed_at = datetime('now'),
                   notes = json_set(COALESCE(notes, '{}'), '$.closedBy', 'sync')
               WHERE id = ?`
            )
            .bind(estimatedPnl, trade.id)
            .run();

          if (trade.notes) {
            await this.cancelTradeOrders(
              symbol,
              trade.notes as string
            );
          }

          console.log(
            `[Sync] ${symbol} ${positionSide} closed on Binance ` +
              `(not found). Estimated P&L: $${estimatedPnl.toFixed(2)}`
          );

          await this.telegram.notifyTradeClose({
            symbol,
            positionSide,
            entryPrice,
            exitPrice: currentPrice,
            pnl: estimatedPnl,
            pnlPercent:
              (estimatedPnl / (entryPrice * quantity)) * 100,
          });
        }
      }
    } catch (error) {
      console.error('[Sync] Error syncing positions:', error);
    }
  }
}
```

---

## 8. Interfaccia Web (Dashboard)

### Setup Frontend

```bash
# Nella root del progetto
npm create vite@latest web -- --template react-ts
cd web
npm install react-router-dom recharts tailwindcss @tailwindcss/vite
```

### API Routes per la Dashboard (src/routes/dashboard.ts)

```typescript
import { Hono } from 'hono';
import { BinanceFuturesClient } from '../binance/client';

type Bindings = {
  DB: D1Database;
  CONFIG: KVNamespace;
  TRADING_STATE: DurableObjectNamespace;
  AUTH_TOKEN: string;
  DASHBOARD_ORIGIN: string;
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  ENVIRONMENT: string;
};

const dashboard = new Hono<{ Bindings: Bindings }>();
dashboard.use('*', async (c, next) => {
  const origin = c.env.DASHBOARD_ORIGIN || 'https://trading-dashboard.pages.dev';
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  await next();
});

/** Health check — public, no auth required */
dashboard.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// Rate limiting - max 60 requests per minute per IP
dashboard.use('*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const key = `ratelimit:${ip}:${Math.floor(Date.now() / 60000)}`;
  const count = parseInt(await c.env.CONFIG.get(key) || '0');

  if (count > 60) {
    return c.json({ error: 'Rate limited' }, 429);
  }

  await c.env.CONFIG.put(key, (count + 1).toString(), {
    expirationTtl: 120,
  });
  await next();
});

/** Bearer token auth middleware (applied to all routes below) */
dashboard.use('*', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  const token = auth.slice(7);
  if (token !== c.env.AUTH_TOKEN) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
});

/** Posizioni aperte */
dashboard.get('/positions', async (c) => {
  const trades = await c.env.DB.prepare(
    `SELECT * FROM trades
     WHERE status = 'OPEN'
     ORDER BY opened_at DESC`
  ).all();
  return c.json(trades.results);
});

/** Posizioni live con P&L unrealized da Binance */
dashboard.get('/positions/live', async (c) => {
  const binance = new BinanceFuturesClient({
    BINANCE_API_KEY: c.env.BINANCE_API_KEY,
    BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
    ENVIRONMENT: c.env.ENVIRONMENT,
  });
  const account = await binance.getAccountInfo();
  const livePositions = account.positions
    .filter((p: any) => parseFloat(p.positionAmt) !== 0)
    .map((p: any) => ({
      symbol: p.symbol,
      positionSide: p.positionSide,
      positionAmt: p.positionAmt,
      entryPrice: p.entryPrice,
      unrealizedProfit: p.unrealizedProfit,
      leverage: p.leverage,
    }));
  return c.json({
    positions: livePositions,
    totalUnrealizedProfit: account.totalUnrealizedProfit,
    totalWalletBalance: account.totalWalletBalance,
    availableBalance: account.availableBalance,
    fetchedAt: new Date().toISOString(),
  });
});

/** Storico trade */
dashboard.get('/trades', async (c) => {
  const limit = Number(c.req.query('limit') || 50);
  const trades = await c.env.DB.prepare(
    `SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return c.json(trades.results);
});

/** Statistiche giornaliere */
dashboard.get('/stats/daily', async (c) => {
  const days = Number(c.req.query('days') || 30);
  const stats = await c.env.DB.prepare(
    `SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?`
  )
    .bind(days)
    .all();
  return c.json(stats.results);
});

/** P&L cumulativo */
dashboard.get('/stats/pnl', async (c) => {
  const pnl = await c.env.DB.prepare(
    `SELECT
       date(opened_at) as date,
       SUM(pnl) as daily_pnl,
       SUM(SUM(pnl)) OVER (ORDER BY date(opened_at))
         as cumulative_pnl,
       COUNT(*) as trades
     FROM trades
     WHERE status = 'CLOSED'
     GROUP BY date(opened_at)
     ORDER BY date ASC`
  ).all();
  return c.json(pnl.results);
});

/** Segnali recenti */
dashboard.get('/signals', async (c) => {
  const signals = await c.env.DB.prepare(
    `SELECT * FROM signals ORDER BY created_at DESC LIMIT 50`
  ).all();
  return c.json(signals.results);
});

/** Configurazione bot */
dashboard.get('/config', async (c) => {
  const config = await c.env.CONFIG.get('trading_config', 'json');
  const botActive = await c.env.CONFIG.get('bot_active');
  const isTestnet = c.env.ENVIRONMENT === 'testnet';
  return c.json({ ...(config || {}), bot_active: botActive === 'true', isTestnet });
});

dashboard.put('/config', async (c) => {
  const body = await c.req.json();

  // Hard-coded safety limits (cannot be overridden via API)
  const LIMITS = {
    maxLeverage: 20,
    maxPositionUsdt: 5000,
    maxRiskPerTrade: 5,
    maxSymbols: 10,
    allowedModels: [
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-3.5-haiku',
      'anthropic/claude-3-haiku',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'openai/gpt-4o',
      'openai/gpt-5-chat',
      'meta-llama/llama-3.2-90b-vision-instruct',
    ],
  };

  const errors: string[] = [];
  if (body.leverage > LIMITS.maxLeverage) errors.push(`leverage max ${LIMITS.maxLeverage}`);
  if (body.maxPositionSizeUsdt > LIMITS.maxPositionUsdt) errors.push(`maxPositionSizeUsdt max ${LIMITS.maxPositionUsdt}`);
  if (body.riskPerTrade > LIMITS.maxRiskPerTrade) errors.push(`riskPerTrade max ${LIMITS.maxRiskPerTrade}%`);
  if (body.symbols?.length > LIMITS.maxSymbols) errors.push(`max ${LIMITS.maxSymbols} symbols`);

  for (const key of ['analystModel', 'strategistModel', 'executorModel']) {
    if (body[key] && !LIMITS.allowedModels.includes(body[key])) {
      errors.push(`${key}: model not in allowlist`);
    }
  }

  if (errors.length > 0) return c.json({ error: 'Validation failed', details: errors }, 400);

  // Clamp values as defense-in-depth
  if (body.leverage) body.leverage = Math.min(body.leverage, LIMITS.maxLeverage);
  if (body.maxPositionSizeUsdt) body.maxPositionSizeUsdt = Math.min(body.maxPositionSizeUsdt, LIMITS.maxPositionUsdt);
  if (body.riskPerTrade) body.riskPerTrade = Math.min(body.riskPerTrade, LIMITS.maxRiskPerTrade);

  const oldConfig = await c.env.CONFIG.get('trading_config');
  await c.env.DB.prepare(
    `INSERT INTO audit_log (action, old_value, new_value, ip)
     VALUES (?, ?, ?, ?)`
  ).bind(
    'config_update',
    oldConfig || '{}',
    JSON.stringify(body),
    c.req.header('CF-Connecting-IP') || 'unknown'
  ).run();
  await c.env.CONFIG.put('trading_config', JSON.stringify(body));
  return c.json({ ok: true });
});

/** Toggle bot on/off */
dashboard.post('/bot/toggle', async (c) => {
  const current = await c.env.CONFIG.get('bot_active');
  const newState = current === 'true' ? 'false' : 'true';
  await c.env.DB.prepare(
    `INSERT INTO audit_log (action, old_value, new_value, ip)
     VALUES (?, ?, ?, ?)`
  ).bind(
    'bot_toggle',
    current,
    newState,
    c.req.header('CF-Connecting-IP') || 'unknown'
  ).run();
  await c.env.CONFIG.put('bot_active', newState);
  return c.json({ active: newState === 'true' });
});

/** Emergency: chiudi tutte le posizioni a mercato */
dashboard.post('/emergency/close-all', async (c) => {
  const binance = new BinanceFuturesClient({
    BINANCE_API_KEY: c.env.BINANCE_API_KEY,
    BINANCE_API_SECRET: c.env.BINANCE_API_SECRET,
    ENVIRONMENT: c.env.ENVIRONMENT,
  });

  const account = await binance.getAccountInfo();
  const openPositions = account.positions.filter(
    (p: any) => parseFloat(p.positionAmt) !== 0
  );

  const results = [];
  for (const pos of openPositions) {
    const posAmt = parseFloat(pos.positionAmt);
    const isLong = posAmt > 0;
    try {
      await binance.newOrder({
        symbol: pos.symbol,
        side: isLong ? 'SELL' : 'BUY',
        positionSide: isLong ? 'LONG' : 'SHORT',
        type: 'MARKET',
        quantity: Math.abs(posAmt),
      });
      results.push({ symbol: pos.symbol, status: 'closed' });
    } catch (err) {
      results.push({ symbol: pos.symbol, status: 'error', error: (err as Error).message });
    }
  }

  // Disattiva il bot
  await c.env.CONFIG.put('bot_active', 'false');

  // Audit log
  await c.env.DB.prepare(
    `INSERT INTO audit_log (action, old_value, new_value, ip)
     VALUES (?, ?, ?, ?)`
  ).bind(
    'emergency_close_all',
    JSON.stringify(openPositions.map((p: any) => p.symbol)),
    JSON.stringify(results),
    c.req.header('CF-Connecting-IP') || 'unknown'
  ).run();

  return c.json({ closed: results, botDisabled: true });
});

dashboard.get('/audit', async (c) => {
  const logs = await c.env.DB.prepare(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100'
  ).all();
  return c.json(logs.results);
});

export default dashboard;
```

### Componente React Dashboard (web/src/App.tsx)

```tsx
import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar, Cell,
} from 'recharts';

const API_URL =
  import.meta.env.VITE_API_URL ||
  'https://binance-trading-bot.YOUR_SUBDOMAIN.workers.dev';

const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || '';
const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };

interface Trade {
  id: number;
  symbol: string;
  side: string;
  position_side: string;
  quantity: number;
  price: number;
  pnl: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
}

interface PnlData {
  date: string;
  daily_pnl: number;
  cumulative_pnl: number;
  trades: number;
}

interface LivePosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  leverage: string;
}

interface LivePositionsResponse {
  positions: LivePosition[];
  totalUnrealizedProfit: string;
  totalWalletBalance: string;
  availableBalance: string;
  fetchedAt: string;
}

export default function App() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [liveAccount, setLiveAccount] = useState<Omit<LivePositionsResponse, 'positions'> | null>(null);
  const [pnlData, setPnlData] = useState<PnlData[]>([]);
  const [botActive, setBotActive] = useState(false);
  const [isTestnet, setIsTestnet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchData();
    fetchLivePositions();
    const dataInterval = setInterval(fetchData, 30000);
    const posInterval = setInterval(fetchLivePositions, 5000);
    return () => {
      clearInterval(dataInterval);
      clearInterval(posInterval);
    };
  }, []);

  async function fetchLivePositions() {
    try {
      const res = await fetch(`${API_URL}/api/dashboard/positions/live`, { headers });
      if (!res.ok) throw new Error(`Positions live: ${res.status}`);
      const data: LivePositionsResponse = await res.json();
      setPositions(data.positions);
      setLiveAccount({
        totalUnrealizedProfit: data.totalUnrealizedProfit,
        totalWalletBalance: data.totalWalletBalance,
        availableBalance: data.availableBalance,
        fetchedAt: data.fetchedAt,
      });
    } catch (e) {
      console.error('Failed to fetch live positions:', e);
    }
  }

  async function fetchData() {
    setError(null);
    const results = await Promise.allSettled([
      fetch(`${API_URL}/api/dashboard/trades`, { headers }),
      fetch(`${API_URL}/api/dashboard/stats/pnl`, { headers }),
      fetch(`${API_URL}/api/dashboard/config`, { headers }),
    ]);

    const errors: string[] = [];

    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      setTrades(await results[0].value.json());
    } else {
      errors.push('Impossibile caricare i trade');
    }

    if (results[1].status === 'fulfilled' && results[1].value.ok) {
      setPnlData(await results[1].value.json());
    } else {
      errors.push('Impossibile caricare i dati P&L');
    }

    if (results[2].status === 'fulfilled' && results[2].value.ok) {
      const config = await results[2].value.json();
      setBotActive(config.bot_active === true);
      setIsTestnet(config.isTestnet === true);
    } else {
      errors.push('Impossibile caricare la configurazione');
    }

    if (errors.length > 0) {
      setError(errors.join(' | '));
    }

    setLastUpdated(new Date());
    setIsLoading(false);
  }

  async function toggleBot() {
    const action = botActive ? 'DISATTIVARE' : 'ATTIVARE';
    const msg = positions.length > 0
      ? `Vuoi ${action} il bot?\n\nAttenzione: hai ${positions.length} posizione/i aperta/e. Gli ordini SL/TP resteranno attivi su Binance, ma il bot non gestira piu le posizioni.`
      : `Vuoi ${action} il bot?`;
    if (!window.confirm(msg)) return;

    const prev = botActive;
    setBotActive(!botActive);
    try {
      const res = await fetch(`${API_URL}/api/dashboard/bot/toggle`, {
        method: 'POST', headers,
      });
      if (!res.ok) throw new Error();
    } catch {
      setBotActive(prev);
      setError('Impossibile cambiare stato del bot. Riprova.');
    }
  }

  async function emergencyCloseAll() {
    const input = window.prompt(
      `EMERGENZA: Stai per chiudere ${positions.length} posizione/i a mercato e disattivare il bot.\n\nDigita CHIUDI per confermare:`
    );
    if (input !== 'CHIUDI') return;

    try {
      const res = await fetch(`${API_URL}/api/dashboard/emergency/close-all`, {
        method: 'POST', headers,
      });
      const data = await res.json();
      setBotActive(false);
      alert(`Chiuse ${data.closed?.length || 0} posizioni. Bot disattivato.`);
      fetchData();
    } catch {
      setError('Errore durante chiusura emergenza. Controlla Binance direttamente!');
    }
  }

  const totalPnl =
    pnlData.length > 0
      ? pnlData[pnlData.length - 1].cumulative_pnl
      : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400 text-center">
          <div className="animate-spin h-8 w-8 border-2 border-gray-400 border-t-white rounded-full mx-auto mb-4" />
          <p>Caricamento dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">
            Binance Trading Bot
          </h1>
          {lastUpdated && (
            <span className="text-xs text-gray-500">
              Aggiornato: {lastUpdated.toLocaleTimeString('it-IT')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {positions.length > 0 && (
            <button
              onClick={emergencyCloseAll}
              className="bg-red-900 hover:bg-red-800 text-red-200 px-4 py-2 rounded-lg font-medium border border-red-700 text-sm"
            >
              CHIUDI TUTTO
            </button>
          )}
          <button
            onClick={toggleBot}
            aria-label={botActive ? 'Disattiva il bot di trading' : 'Attiva il bot di trading'}
            className={`px-4 py-2 rounded-lg font-medium ${
              botActive
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            Bot: {botActive ? 'ATTIVO' : 'FERMO'}
          </button>
        </div>
      </header>

      {/* Environment banner */}
      {isTestnet && (
        <div className="bg-yellow-600 text-black text-center py-2 text-sm font-bold mb-4 rounded-lg">
          AMBIENTE TESTNET - Nessun denaro reale
        </div>
      )}

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-lg mb-6">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="P&L Totale"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
          color={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}
        />
        <StatCard
          label="Posizioni Aperte"
          value={positions.length.toString()}
        />
        <StatCard
          label="Trade Totali"
          value={trades.length.toString()}
        />
        <StatCard
          label="Win Rate"
          value={`${calcWinRate(trades)}%`}
          color="text-blue-400"
        />
      </div>

      {/* P&L Chart */}
      <div className="bg-gray-900 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">
          P&L Cumulativo
        </h2>
        {pnlData.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] text-gray-500">
            Nessun dato P&L. I grafici appariranno dopo il primo trade chiuso.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={pnlData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#374151"
              />
              <XAxis dataKey="date" stroke="#9CA3AF" tickFormatter={(d) => new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })} />
              <YAxis stroke="#9CA3AF" tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '8px' }}
                formatter={(value: number, name: string) => [
                  `$${value.toFixed(2)}`,
                  name === 'cumulative_pnl' ? 'P&L Cumulativo' : 'P&L Giornaliero',
                ]}
                labelFormatter={(d) => new Date(d).toLocaleDateString('it-IT', {
                  weekday: 'long', day: 'numeric', month: 'long',
                })}
              />
              <Line
                type="monotone"
                dataKey="cumulative_pnl"
                stroke={totalPnl >= 0 ? '#10B981' : '#EF4444'}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Daily P&L Bar Chart */}
      <div className="bg-gray-900 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">
          P&L Giornaliero
        </h2>
        {pnlData.length === 0 ? (
          <div className="flex items-center justify-center h-[200px] text-gray-500">
            Nessun dato P&L. I grafici appariranno dopo il primo trade chiuso.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={pnlData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#374151"
              />
              <XAxis dataKey="date" stroke="#9CA3AF" tickFormatter={(d) => new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })} />
              <YAxis stroke="#9CA3AF" tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '8px' }}
                formatter={(value: number, name: string) => [
                  `$${value.toFixed(2)}`,
                  name === 'cumulative_pnl' ? 'P&L Cumulativo' : 'P&L Giornaliero',
                ]}
                labelFormatter={(d) => new Date(d).toLocaleDateString('it-IT', {
                  weekday: 'long', day: 'numeric', month: 'long',
                })}
              />
              <Bar dataKey="daily_pnl">
                {pnlData.map((entry, index) => (
                  <Cell key={index} fill={entry.daily_pnl >= 0 ? '#10B981' : '#EF4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Open Positions (live from Binance) */}
      <div className="bg-gray-900 rounded-xl p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            Posizioni Aperte (Live)
          </h2>
          {liveAccount && (
            <span className="text-xs text-gray-500">
              Unrealized: <span className={parseFloat(liveAccount.totalUnrealizedProfit) >= 0 ? 'text-green-400' : 'text-red-400'}>
                {parseFloat(liveAccount.totalUnrealizedProfit) >= 0 ? '+' : ''}${parseFloat(liveAccount.totalUnrealizedProfit).toFixed(2)}
              </span>
              {' | '}Balance: ${parseFloat(liveAccount.totalWalletBalance).toFixed(2)}
            </span>
          )}
        </div>
        {/* Mobile: card layout */}
        <div className="md:hidden space-y-3">
          {positions.map((p) => (
            <div key={`${p.symbol}-${p.positionSide}-m`} className="bg-gray-800 rounded-lg p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold text-base">{p.symbol}</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  p.positionSide === 'LONG' || parseFloat(p.positionAmt) > 0
                    ? 'bg-green-900 text-green-300'
                    : 'bg-red-900 text-red-300'
                }`}>
                  {p.positionSide !== 'BOTH' ? p.positionSide : parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-300">
                <div>Entry: <span className="text-white">${parseFloat(p.entryPrice).toFixed(2)}</span></div>
                <div>Qty: <span className="text-white">{p.positionAmt}</span></div>
                <div>Leva: <span className="text-white">{p.leverage}x</span></div>
                <div className={`col-span-2 text-base font-semibold ${parseFloat(p.unrealizedProfit) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  P&L: {parseFloat(p.unrealizedProfit) >= 0 ? '+' : ''}${parseFloat(p.unrealizedProfit).toFixed(2)}
                </div>
              </div>
            </div>
          ))}
          {positions.length === 0 && (
            <p className="text-center py-4 text-gray-500">Nessuna posizione aperta</p>
          )}
        </div>
        {/* Desktop: table layout */}
        <table className="hidden md:table w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th scope="col" className="text-left py-2">Simbolo</th>
              <th scope="col" className="text-left">Direzione</th>
              <th scope="col" className="text-right">Quantita</th>
              <th scope="col" className="text-right">Entry</th>
              <th scope="col" className="text-right">Leva</th>
              <th scope="col" className="text-right">P&L Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr
                key={`${p.symbol}-${p.positionSide}`}
                className="border-b border-gray-800"
              >
                <td className="py-2 font-medium">{p.symbol}</td>
                <td>
                  <span
                    className={`px-2 py-1 rounded text-xs ${
                      p.positionSide === 'LONG' || parseFloat(p.positionAmt) > 0
                        ? 'bg-green-900 text-green-300'
                        : 'bg-red-900 text-red-300'
                    }`}
                  >
                    {p.positionSide !== 'BOTH' ? p.positionSide : parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'}
                  </span>
                </td>
                <td className="text-right">{p.positionAmt}</td>
                <td className="text-right">
                  ${parseFloat(p.entryPrice).toFixed(2)}
                </td>
                <td className="text-right">{p.leverage}x</td>
                <td
                  className={`text-right ${
                    parseFloat(p.unrealizedProfit) >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                  }`}
                >
                  {parseFloat(p.unrealizedProfit) >= 0 ? '+' : ''}${parseFloat(p.unrealizedProfit).toFixed(2)}
                </td>
              </tr>
            ))}
            {positions.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-center py-4 text-gray-500"
                >
                  Nessuna posizione aperta
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Trade History */}
      <div className="bg-gray-900 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">
          Storico Trade
        </h2>
        {/* Mobile: card layout */}
        <div className="md:hidden space-y-3">
          {trades.slice(0, 20).map((t) => (
            <div key={`${t.id}-m`} className="bg-gray-800 rounded-lg p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold text-base">{t.symbol}</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  t.position_side === 'LONG'
                    ? 'bg-green-900 text-green-300'
                    : 'bg-red-900 text-red-300'
                }`}>
                  {t.position_side}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-300">
                <div>Data: <span className="text-white">{new Date(t.opened_at).toLocaleDateString()}</span></div>
                <div>Entry: <span className="text-white">${t.price?.toFixed(2)}</span></div>
                <div>Status: <span className={`text-xs ${t.status === 'OPEN' ? 'text-yellow-400' : 'text-gray-300'}`}>{t.status}</span></div>
                <div className={`col-span-2 text-base font-semibold ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  P&L: {t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '-'}
                </div>
              </div>
            </div>
          ))}
          {trades.length === 0 && (
            <p className="text-center py-4 text-gray-500">Nessun trade registrato</p>
          )}
        </div>
        {/* Desktop: table layout */}
        <table className="hidden md:table w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th scope="col" className="text-left py-2">Data</th>
              <th scope="col" className="text-left">Simbolo</th>
              <th scope="col" className="text-left">Dir.</th>
              <th scope="col" className="text-right">Entry</th>
              <th scope="col" className="text-right">P&L</th>
              <th scope="col" className="text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 20).map((t) => (
              <tr
                key={t.id}
                className="border-b border-gray-800"
              >
                <td className="py-2 text-gray-300">
                  {new Date(t.opened_at).toLocaleDateString()}
                </td>
                <td className="font-medium">{t.symbol}</td>
                <td>
                  <span
                    className={`px-2 py-1 rounded text-xs ${
                      t.position_side === 'LONG'
                        ? 'bg-green-900 text-green-300'
                        : 'bg-red-900 text-red-300'
                    }`}
                  >
                    {t.position_side}
                  </span>
                </td>
                <td className="text-right">
                  ${t.price?.toFixed(2)}
                </td>
                <td
                  className={`text-right ${
                    t.pnl >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                  }`}
                >
                  {t.pnl !== null
                    ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`
                    : '-'}
                </td>
                <td>
                  <span
                    className={`text-xs ${
                      t.status === 'OPEN'
                        ? 'text-yellow-400'
                        : 'text-gray-400'
                    }`}
                  >
                    {t.status}
                  </span>
                </td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-center py-4 text-gray-500"
                >
                  Nessun trade registrato
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color = 'text-white',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <p className="text-sm text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>
        {value}
      </p>
    </div>
  );
}

function calcWinRate(trades: Trade[]): string {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  if (closed.length === 0) return '0.0';
  const wins = closed.filter((t) => t.pnl > 0).length;
  return ((wins / closed.length) * 100).toFixed(1);
}
```

---

## 9. Cron Triggers e Strategie

### Entry Point (src/index.ts)

```typescript
import { Hono } from 'hono';
import { BinanceFuturesClient } from './binance/client';
import { TelegramBot } from './telegram/bot';
import { TradingEngine } from './trading/engine';
import { RiskManager, RiskConfig } from './trading/risk';
import dashboard from './routes/dashboard';

type Bindings = {
  DB: D1Database;
  CONFIG: KVNamespace;
  TRADING_STATE: DurableObjectNamespace;
  BINANCE_API_KEY: string;
  BINANCE_API_SECRET: string;
  ENVIRONMENT: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  WAVESPEED_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Dashboard API routes
app.route('/api/dashboard', dashboard);

// Health check
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString(), environment: c.env.ENVIRONMENT })
);

// Export per Cloudflare Workers
export default {
  // HTTP handler (dashboard + API)
  fetch: app.fetch,

  // Cron handler - il cuore del bot
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext
  ): Promise<void> {
    const binance = new BinanceFuturesClient({
      BINANCE_API_KEY: env.BINANCE_API_KEY,
      BINANCE_API_SECRET: env.BINANCE_API_SECRET,
      ENVIRONMENT: env.ENVIRONMENT,
    });

    const telegram = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID
    );

    // Controlla se il bot e attivo
    const botActive = await env.CONFIG.get('bot_active');
    if (botActive !== 'true') return;

    // Carica configurazione
    const configJson = (await env.CONFIG.get(
      'trading_config',
      'json'
    )) as any;

    const config = {
      symbols: configJson?.symbols || ['BTCUSDT', 'ETHUSDT'],
      maxPositions: configJson?.maxPositions || 3,
      maxPositionSizeUsdt:
        configJson?.maxPositionSizeUsdt || 500,
      leverage: configJson?.leverage || 5,
      useLlmPipeline: configJson?.useLlmPipeline ?? true,
      analystModel:
        configJson?.analystModel || 'anthropic/claude-haiku-4.5',
      strategistModel:
        configJson?.strategistModel || 'anthropic/claude-sonnet-4.5',
      executorModel:
        configJson?.executorModel || 'anthropic/claude-sonnet-4.6',
      minSignalStrength: configJson?.minSignalStrength || 0.5,
      riskPerTrade: configJson?.riskPerTrade || 2,
    };

    const riskConfig: RiskConfig = {
      maxDailyLoss: configJson?.maxDailyLoss || 100,
      maxDailyLossPercent: configJson?.maxDailyLossPercent || 5,
      maxDrawdown: configJson?.maxDrawdown || 15,
      maxPositionSize: config.maxPositionSizeUsdt,
      maxLeverage: config.leverage,
      maxOpenPositions: config.maxPositions,
      cooldownAfterLoss: configJson?.cooldownAfterLoss || 15,
    };

    const engine = new TradingEngine(
      binance,
      telegram,
      config.useLlmPipeline ? env.WAVESPEED_API_KEY : null,
      config,
      riskConfig
    );

    // Determina azione in base al cron
    const cronName = event.cron;

    if (cronName === '*/2 * * * *') {
      // Ogni 2 minuti: sync posizioni + controlla pending + analisi + trading
      await engine.syncPositions(env.DB);
      await engine.checkPendingOrders(env.DB);
      await engine.run(env.DB);
    } else if (cronName === '0 * * * *') {
      // Ogni ora: report orario (opzionale)
    } else if (cronName === '0 0 * * *') {
      // Mezzanotte: report giornaliero
      await sendDailyReport(env, telegram);
    }
  },
};

async function sendDailyReport(
  env: Bindings,
  telegram: TelegramBot
) {
  const today = new Date().toISOString().split('T')[0];

  const result = await env.DB.prepare(
    `SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)
        as winning_trades,
      SUM(pnl) as total_pnl
    FROM trades
    WHERE date(closed_at) = ? AND status = 'CLOSED'`
  )
    .bind(today)
    .first();

  if (!result) return;

  const binance = new BinanceFuturesClient({
    BINANCE_API_KEY: env.BINANCE_API_KEY,
    BINANCE_API_SECRET: env.BINANCE_API_SECRET,
    ENVIRONMENT: env.ENVIRONMENT,
  });

  const account = await binance.getAccountInfo();
  const balance = parseFloat(account.totalWalletBalance);

  const totalTrades = (result.total_trades as number) || 0;
  const winningTrades =
    (result.winning_trades as number) || 0;
  const winRate =
    totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  await telegram.notifyDailyReport({
    date: today,
    totalTrades,
    winRate,
    totalPnl: (result.total_pnl as number) || 0,
    balance,
  });

  // Salva stats giornaliere
  await env.DB.prepare(
    `INSERT OR REPLACE INTO daily_stats
       (date, total_trades, winning_trades,
        losing_trades, total_pnl, balance_snapshot)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      today,
      totalTrades,
      winningTrades,
      totalTrades - winningTrades,
      (result.total_pnl as number) || 0,
      balance
    )
    .run();
}

// Esporta Durable Object
export { TradingState } from './storage/durable-object';
```

### Durable Object per Stato (src/storage/durable-object.ts)

```typescript
export class TradingState {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/get-state': {
        const positions =
          (await this.state.storage.get('positions')) || [];
        const lastSignals =
          (await this.state.storage.get('lastSignals')) || {};
        return Response.json({ positions, lastSignals });
      }

      case '/update-position': {
        const body = (await request.json()) as any;
        const positions =
          ((await this.state.storage.get('positions')) ||
            []) as any[];

        if (body.action === 'open') {
          positions.push(body.position);
        } else if (body.action === 'close') {
          const idx = positions.findIndex(
            (p: any) =>
              p.symbol === body.symbol &&
              p.positionSide === body.positionSide
          );
          if (idx >= 0) positions.splice(idx, 1);
        }

        await this.state.storage.put('positions', positions);
        return Response.json({ ok: true });
      }

      case '/update-signal': {
        const signal = (await request.json()) as any;
        const lastSignals =
          ((await this.state.storage.get('lastSignals')) ||
            {}) as any;
        lastSignals[signal.symbol] = signal;
        await this.state.storage.put(
          'lastSignals',
          lastSignals
        );
        return Response.json({ ok: true });
      }

      default:
        return new Response('Not found', { status: 404 });
    }
  }
}
```

---

## 10. Deploy e Operativita

### Step-by-Step Deploy

```bash
# 1. Inizializza il database D1
wrangler d1 execute trading-bot --file=./schema.sql

# 2. Configura i secrets
wrangler secret put BINANCE_API_KEY
wrangler secret put BINANCE_API_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put WAVESPEED_API_KEY
wrangler secret put AUTH_TOKEN

# 3. Imposta configurazione iniziale in KV
wrangler kv key put --binding CONFIG "bot_active" "false"
wrangler kv key put --binding CONFIG "trading_config" \
  '{"symbols":["BTCUSDT","ETHUSDT"],"maxPositions":3,"maxPositionSizeUsdt":500,"leverage":5,"useLlmPipeline":true,"analystModel":"anthropic/claude-haiku-4.5","strategistModel":"anthropic/claude-sonnet-4.5","executorModel":"anthropic/claude-sonnet-4.6","minSignalStrength":0.5,"riskPerTrade":2}'

# 4. Deploy il worker
wrangler deploy

# 5. Abilita Hedge Mode su Binance (una tantum)
# Il bot lo puo fare automaticamente al primo avvio

# 6. Deploy frontend (Cloudflare Pages)
cd web
npm run build
wrangler pages deploy dist --project-name trading-dashboard

# 7. Attiva il bot (quando sei pronto)
wrangler kv key put --binding CONFIG "bot_active" "true"
```

### Comandi Utili

```bash
# Vedi log in tempo reale
wrangler tail

# Testa il cron localmente
wrangler dev --test-scheduled

# Controlla stato D1
wrangler d1 execute trading-bot \
  --command "SELECT * FROM trades ORDER BY opened_at DESC LIMIT 10"

# Disattiva il bot in emergenza
wrangler kv key put --binding CONFIG "bot_active" "false"
```

### Workflow di Sviluppo Consigliato

1. **Sviluppa** con `wrangler dev` e Binance Testnet
2. **Testa** i segnali senza eseguire ordini (paper trading)
3. **Valida** su testnet per almeno 2 settimane
4. **Passa** a mainnet con size molto piccole
5. **Scala** gradualmente dopo risultati positivi

---

## 11. Sicurezza e Risk Management

### Regole di Risk Management (FONDAMENTALI)

```typescript
// src/trading/risk.ts

export interface RiskConfig {
  maxDailyLoss: number;        // Max perdita giornaliera in USDT
  maxDailyLossPercent: number; // Max perdita giornaliera in %
  maxDrawdown: number;         // Max drawdown totale in %
  maxPositionSize: number;     // Max size singola posizione USDT
  maxLeverage: number;         // Leva massima consentita
  maxOpenPositions: number;    // Max posizioni simultanee
  cooldownAfterLoss: number;   // Minuti pausa dopo una perdita
}

export class RiskManager {
  private config: RiskConfig;

  constructor(config: RiskConfig) {
    this.config = config;
  }

  /** Controlla se possiamo aprire un nuovo trade */
  async canTrade(
    db: D1Database,
    balance: number
  ): Promise<{ allowed: boolean; reason?: string }> {
    const today = new Date().toISOString().split('T')[0];

    // 1. Controlla perdita giornaliera
    const dailyPnl = await db
      .prepare(
        `SELECT COALESCE(SUM(pnl), 0) as total
         FROM trades
         WHERE date(closed_at) = ? AND status = 'CLOSED'`
      )
      .bind(today)
      .first();

    const dailyLoss = (dailyPnl?.total as number) || 0;
    if (dailyLoss <= -this.config.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Max daily loss raggiunto: $${dailyLoss.toFixed(2)}`,
      };
    }
    if (
      dailyLoss <=
      -(balance * this.config.maxDailyLossPercent) / 100
    ) {
      return {
        allowed: false,
        reason: 'Max daily loss % raggiunto',
      };
    }

    // 2. Controlla cooldown dopo ultima perdita
    const lastLoss = await db
      .prepare(
        `SELECT closed_at FROM trades
         WHERE pnl < 0 AND status = 'CLOSED'
         ORDER BY closed_at DESC LIMIT 1`
      )
      .first();

    if (lastLoss?.closed_at) {
      const lossTime = new Date(
        lastLoss.closed_at as string
      ).getTime();
      const cooldownMs =
        this.config.cooldownAfterLoss * 60 * 1000;
      if (Date.now() - lossTime < cooldownMs) {
        const remaining = Math.ceil(
          (cooldownMs - (Date.now() - lossTime)) / 60000
        );
        return {
          allowed: false,
          reason: `Cooldown attivo: ${remaining} min rimanenti`,
        };
      }
    }

    // 3. Controlla numero posizioni aperte
    const openCount = await db
      .prepare(
        `SELECT COUNT(*) as count
         FROM trades WHERE status = 'OPEN'`
      )
      .first();

    if (
      (openCount?.count as number) >=
      this.config.maxOpenPositions
    ) {
      return {
        allowed: false,
        reason: 'Max posizioni aperte raggiunto',
      };
    }

    return { allowed: true };
  }

  /** Calcola size della posizione basata sul rischio */
  calculatePositionSize(
    balance: number,
    riskPercent: number,
    entryPrice: number,
    stopLossPrice: number,
    leverage: number
  ): number {
    const riskAmount = balance * (riskPercent / 100);
    const priceDiff = Math.abs(entryPrice - stopLossPrice);
    const riskPerUnit = priceDiff / entryPrice;

    let size = riskAmount / riskPerUnit;

    // Cap alla max position size
    size = Math.min(size, this.config.maxPositionSize);

    return size;
  }
}
```

### Checklist Sicurezza

- [ ] **API Keys**: Mai nel codice. Usa sempre `wrangler secret put`
- [ ] **IP Whitelist**: Imposta su Binance (Cloudflare Workers IPs)
- [ ] **No Withdrawal**: Non abilitare mai il permesso di prelievo
- [ ] **Testnet First**: Sviluppa e testa SEMPRE su testnet prima
- [ ] **Rate Limits**: Binance ha limiti di 1200 req/min - rispettali
- [ ] **Max Loss**: Implementa SEMPRE un circuit breaker per perdita max
- [ ] **Hedge Mode**: Abilita per poter fare Long e Short in sicurezza
- [ ] **Leva Bassa**: Inizia con 2-5x, mai oltre 10x per trading auto
- [ ] **Monitoring**: Controlla i log con `wrangler tail` regolarmente
- [ ] **Kill Switch**: Il toggle on/off via KV deve essere sempre accessibile

### Costi Stimati

| Risorsa | Piano Free | Piano Paid |
|---------|-----------|------------|
| Workers Requests | 100K/giorno | $0.30/milione |
| KV Reads | 100K/giorno | $0.50/milione |
| D1 Reads | 5M/giorno | $0.001/milione |
| D1 Writes | 100K/giorno | $0.001/milione |
| D1 Storage | 5GB | $0.75/GB/mese |
| Durable Objects | Incluso | $0.15/milione req |
| Telegram Bot | Gratuito | Gratuito |
| WaveSpeed AI (pipeline LLM) | - | ~$1.17/giorno (3 simboli) |
| **Totale stimato** | **$0** (free tier) | **~$35-40/mese** |

> Con un cron ogni 2 minuti su 3 simboli, generi circa 65K requests/giorno al worker, dentro il free tier.

---

## Quick Start - Riassunto Comandi

```bash
# Setup iniziale
npm create cloudflare@latest binance-trading-bot -- \
  --template worker-typescript
cd binance-trading-bot
npm install hono zod

# Crea risorse
wrangler kv namespace create CONFIG
wrangler d1 create trading-bot
# Aggiorna wrangler.toml con gli ID

# Schema DB
wrangler d1 execute trading-bot --file=./schema.sql

# Secrets
wrangler secret put BINANCE_API_KEY
wrangler secret put BINANCE_API_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put WAVESPEED_API_KEY
wrangler secret put AUTH_TOKEN

# Sviluppo locale
wrangler dev

# Deploy
wrangler deploy

# Attiva
wrangler kv key put --binding CONFIG "bot_active" "true"

# Monitor
wrangler tail
```

---

## Disclaimer

> **ATTENZIONE**: Il trading di criptovalute con leva finanziaria comporta rischi elevati di perdita del capitale. Questo progetto e fornito a scopo educativo. Non investire mai piu di quanto puoi permetterti di perdere. Testa sempre su testnet prima di usare fondi reali. L'autore non e responsabile per eventuali perdite finanziarie derivanti dall'uso di questo software.

---

## Fonti e Riferimenti

- [Binance Futures API - Documentazione ufficiale](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [Binance New Order endpoint](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api)
- [Binance Long/Short Ratio](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio)
- [Cloudflare Workers - Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Durable Objects - Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Hono Framework - Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [WaveSpeed AI - Any LLM API](https://wavespeed.ai/docs/docs-api/wavespeed-ai/any-llm)
- [WaveSpeed AI - Authentication](https://wavespeed.ai/docs/docs-authentication)
- [WaveSpeed AI - Pricing](https://wavespeed.ai/pricing)
