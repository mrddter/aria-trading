# Mainnet Migration Guide

Guida completa per migrare il bot di trading da Binance Futures **Testnet** a **Mainnet**.

> **ATTENZIONE:** Su mainnet si usano soldi veri. Ogni errore costa denaro reale. Segui questa guida passo per passo, senza fretta.

---

## Pre-requisiti

### Risultati Testnet (obbligatori)
Prima di andare live, il bot deve aver dimostrato performance consistenti su testnet:

| Metrica | Minimo Richiesto | Come Verificare |
|---------|-----------------|-----------------|
| Sharpe Ratio | > 1.0 | `/perf` su Telegram |
| Win Rate | > 52% | `/perf` su Telegram |
| Numero trade | 200+ chiusi | `/perf` su Telegram |
| Max Drawdown | < 15% | `/perf` su Telegram |
| Periodo test | >= 2 settimane | Data primo trade |
| Profit Factor | > 1.3 | `/perf` su Telegram |

Se anche UNA sola metrica non e' soddisfatta, **non procedere**. Continua a testare.

### Account Binance
- Account Binance verificato con **KYC completo** (livello Intermediate minimo)
- **Futures Trading** abilitato (Settings > Futures > Enable)
- **Hedge Mode** abilitato (Futures > Settings > Position Mode > Hedge Mode)
- Margine **Cross** selezionato come default

### Capitale Iniziale
- **Minimo consigliato:** $500 USDT
- **Ideale per iniziare:** $500-1000 USDT
- Non investire piu' di quanto puoi permetterti di perdere
- Tieni una riserva di almeno 2x il capitale investito nel conto bancario

### Infrastruttura
- Account Cloudflare Workers attivo (free tier sufficiente)
- API key WaveSpeed AI funzionante
- Bot Telegram configurato e funzionante

---

## Step 1: Configurazione Binance Mainnet

### 1.1 Crea una nuova API Key (Mainnet)

> **IMPORTANTE:** NON usare la stessa API key del testnet. Il testnet ha un sistema di chiavi completamente separato.

1. Vai su [Binance API Management](https://www.binance.com/en/my/settings/api-management)
2. Clicca "Create API" > "System generated"
3. Dai un nome descrittivo: `trading-bot-live-cf-workers`
4. Completa la 2FA

### 1.2 Configura i Permessi

Abilita **SOLO** questi permessi:
- [x] Enable Futures (obbligatorio)
- [ ] Enable Reading (opzionale, per /account)
- [ ] Enable Spot & Margin Trading (NO!)
- [ ] Enable Withdrawals (ASSOLUTAMENTE NO!)
- [ ] Enable Internal Transfer (NO!)

### 1.3 Restrizione IP

Le API key di trading **devono** essere IP-restricted. Cloudflare Workers usa IP dinamici, quindi hai due opzioni:

**Opzione A: Unrestricted (piu' semplice, meno sicuro)**
Seleziona "Unrestricted" per le IP. Compensa con:
- Nessun permesso di withdrawal
- Solo Futures abilitato
- Monitora i login con Binance Security

**Opzione B: IP Restriction con Cloudflare (piu' sicuro)**
Cloudflare Workers esce da questi range CIDR (verificare su [Cloudflare IP ranges](https://www.cloudflare.com/ips/)):

```
IPv4:
173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22
```

> Nota: Binance potrebbe non accettare CIDR cosi' ampi. In quel caso, usa Opzione A.

### 1.4 Abilita Hedge Mode

Se non l'hai gia' fatto:
1. Vai su Futures > icona ingranaggio in alto a destra
2. "Position Mode" > seleziona **Hedge Mode**
3. Conferma

Il bot lo fa anche automaticamente all'avvio (`setPositionMode(true)` in `index.ts`), ma e' meglio farlo manualmente prima.

### 1.5 Imposta Cross Margin come Default

Futures > Settings > Margin Mode > **Cross**

---

## Step 2: Modifiche al Codice

### 2.1 wrangler.toml

Il file attuale:
```toml
name = "binance-trading-bot"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[triggers]
crons = ["*/5 * * * *"]

[vars]
ENVIRONMENT = "testnet"
BOT_ACTIVE = "true"

[ai]
binding = "AI"
```

Per mainnet, crea un **nuovo file** `wrangler.production.toml`:

```toml
name = "binance-trading-bot-live"
main = "src/index.ts"
compatibility_date = "2026-03-01"

# Cron: every 5 minutes
[triggers]
crons = ["*/5 * * * *"]

[vars]
ENVIRONMENT = "production"
BOT_ACTIVE = "false"    # Inizia SPENTO! Accendi solo dopo i test

[ai]
binding = "AI"
```

Differenze chiave:
- `name` diverso (`binance-trading-bot-live`): crea un Worker **separato** dal testnet
- `ENVIRONMENT = "production"`: fa switchare automaticamente l'URL in `client.ts`
- `BOT_ACTIVE = "false"`: il bot parte spento, lo accendi tu quando sei pronto

Il codice in `src/binance/client.ts` gestisce gia' lo switch automatico:
```typescript
// Hardcoded URLs - never trust user-configurable base URLs
private static readonly URLS = {
  mainnet: 'https://fapi.binance.com',
  testnet: 'https://testnet.binancefuture.com',
} as const;

constructor(env: BinanceEnv) {
  this.baseUrl = env.ENVIRONMENT === 'testnet'
    ? BinanceFuturesClient.URLS.testnet
    : BinanceFuturesClient.URLS.mainnet;  // <-- qualsiasi valore != 'testnet' va su mainnet
}
```

### 2.2 Secrets

Imposta i secrets per il Worker **live** (sono separati dal testnet):

```bash
# API key mainnet (NUOVE, non quelle testnet!)
wrangler secret put BINANCE_API_KEY --config wrangler.production.toml
wrangler secret put BINANCE_API_SECRET --config wrangler.production.toml

# Questi restano gli stessi del testnet
wrangler secret put WAVESPEED_API_KEY --config wrangler.production.toml
wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.production.toml
wrangler secret put TELEGRAM_CHAT_ID --config wrangler.production.toml
```

### 2.3 Entry Strategy: LIMIT invece di MARKET

Su testnet si usa `MARKET` perche' l'orderbook e' sottile e non importa. Su mainnet, gli ordini `MARKET` pagano taker fee (0.04%) e possono avere slippage su altcoin meno liquide.

**Modifica in `src/trading/engine.ts`**, metodo `executeTrade()`:

**Prima (testnet):**
```typescript
const order = await this.binance.newOrder({
  symbol,
  side: side as 'BUY' | 'SELL',
  positionSide: direction as 'LONG' | 'SHORT',
  type: 'MARKET',
  quantity,
});
```

**Dopo (mainnet):**
```typescript
// LIMIT order con tolleranza 0.05% per fill rapido
const tolerance = 0.0005; // 0.05%
let limitPrice: number;
if (side === 'BUY') {
  limitPrice = this.binance.roundPrice(symbol, price * (1 + tolerance));
} else {
  limitPrice = this.binance.roundPrice(symbol, price * (1 - tolerance));
}

const order = await this.binance.newOrder({
  symbol,
  side: side as 'BUY' | 'SELL',
  positionSide: direction as 'LONG' | 'SHORT',
  type: 'LIMIT',
  quantity,
  price: limitPrice,
  timeInForce: 'GTC',
});
```

Inoltre, aggiungi un **check per ordini pending** alla prossima iterazione del cron. Se un ordine LIMIT non viene eseguito entro 60 secondi (il prossimo ciclo cron), cancellalo:

```typescript
// In checkSoftOrders() o in un nuovo metodo checkPendingOrders():
async checkPendingOrders(): Promise<void> {
  try {
    const openOrders = await this.binance.getOpenOrders() as any[];
    for (const order of openOrders) {
      // Cancella ordini LIMIT non filled dopo 60 secondi
      if (order.type === 'LIMIT' && order.status === 'NEW') {
        const ageMs = Date.now() - order.time;
        if (ageMs > 60_000) {
          await this.binance.cancelOrder(order.symbol, order.orderId.toString());
          console.log(`[Trade] Cancelled stale LIMIT order ${order.orderId} for ${order.symbol}`);
          // Rimuovi anche il soft SL/TP associato
          const key = `${order.symbol}:${order.positionSide}`;
          // softOrders.delete(key); // solo se l'ordine entry non e' stato filled
        }
      }
    }
  } catch (err) {
    console.error('[Trade] Error checking pending orders:', (err as Error).message);
  }
}
```

Poi chiamalo nel cron in `index.ts`, prima di `checkSoftOrders()`:

```typescript
// 0. Cancel stale pending orders
await eng.checkPendingOrders();

// 1. Check software SL/TP first (safety net for failed algo orders)
await eng.checkSoftOrders();
```

### 2.4 SL/TP: Algo Orders (funzioneranno su mainnet)

Buone notizie: il codice per gli algo orders SL/TP e' **gia' corretto** per mainnet. Il problema attuale e' solo del testnet, dove gli algo orders falliscono per molti symbol.

```typescript
// Questo codice in executeTrade() e' gia' pronto per mainnet:
await this.binance.newAlgoOrder({
  symbol,
  side: (direction === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
  positionSide: direction as 'LONG' | 'SHORT',
  type: 'STOP_MARKET',
  triggerPrice: roundedSL,
  closePosition: true,
});
```

Su mainnet:
- Gli algo orders verranno eseguiti dal matching engine di Binance (nessuna latenza extra)
- Lo slippage sara' minimo grazie alla profondita' dell'orderbook
- Il software SL/TP (`checkSoftOrders()`) **deve restare attivo** come safety net
  - Se l'algo order fallisce per qualsiasi motivo, il software SL/TP chiude la posizione al prossimo ciclo cron (max 5 minuti di ritardo)

### 2.5 Risk Parameters (CONSERVATIVI per le prime 2 settimane)

Modifica la config in `src/index.ts`, funzione `getEngine()`:

**Prima (testnet):**
```typescript
const config: EngineConfig = {
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  ],
  leverage: 3,
  riskPerTrade: 1.5,
  maxPositionSizeUsdt: 500,
  maxPositions: 4,
  enableEventDriven: true,
  enableMarketNeutral: true,
  analystModel: 'anthropic/claude-haiku-4.5',
  highImpactModel: 'anthropic/claude-sonnet-4.5',
};
```

**Dopo (mainnet, prime 2 settimane):**
```typescript
const config: EngineConfig = {
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  ],
  leverage: 3,              // Resta 3x, NON alzare subito
  riskPerTrade: 1,           // 1% per trade (era 1.5%)
  maxPositionSizeUsdt: 100,  // $100 max per posizione (era $500)
  maxPositions: 3,           // Max 3 simultanee (era 4)
  enableEventDriven: true,
  enableMarketNeutral: true,
  analystModel: 'anthropic/claude-haiku-4.5',
  highImpactModel: 'anthropic/claude-sonnet-4.5',
};
```

Rationale:
- `leverage: 3` - conservativo, non 5x o 10x. Con 3x e SL a 2% dal prezzo, il max loss per trade e' ~6% della position size
- `riskPerTrade: 1` - rischi solo l'1% del balance per trade. Con $500 = $5 di rischio per trade
- `maxPositionSizeUsdt: 100` - anche se il position sizing dice di piu', non superare $100 per posizione
- `maxPositions: 3` - max 3 posizioni aperte = max 3% di rischio totale

### 2.6 Stablecoin Filter

Aggiungi un filtro per escludere stablecoin pegged al dollaro. Non ha senso tradare USDCUSDT con un bot di sentiment.

In `src/trading/engine.ts`, aggiungi all'inizio del file:

```typescript
// Stablecoins and pegged assets to exclude from trading
const EXCLUDED_SYMBOLS = new Set([
  'USDCUSDT', 'BUSDUSDT', 'DAIUSDT', 'TUSDUSDT', 'FDUSDUSDT',
  'USDPUSDT', 'EURUSDT', 'GBPUSDT', 'JPYUSDT', 'TRYUSDT',
]);
```

Poi in `executeTrade()`, aggiungi il check all'inizio:

```typescript
private async executeTrade(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  price: number,
  stopLoss: number,
  takeProfit: number,
  balance: number,
  strategy: string
): Promise<void> {
  // Skip stablecoins and fiat pairs
  if (EXCLUDED_SYMBOLS.has(symbol)) {
    console.log(`[Trade] ${symbol} is excluded (stablecoin/fiat), skipping`);
    return;
  }
  // ... rest of method
```

Aggiungi lo stesso check anche in `processEventDriven()` e `executeSentimentTrade()`.

### 2.7 Aggiorna startingBalance per /costs e /perf

In `src/index.ts`, il balance iniziale e' hardcoded a 5000 (testnet):

```typescript
const startingBalance = 5000; // Testnet initial
```

Cambialo in base al tuo deposito effettivo su mainnet:

```typescript
const startingBalance = 500; // Mainnet initial deposit
```

Fai lo stesso per il calcolo in `/costs`:

```typescript
const realizedPnl = parseFloat(account.totalWalletBalance) - 500; // Era 5000
```

---

## Step 3: Deploy Procedure

### 3.1 Crea il Worker Mainnet (separato dal testnet)

```bash
# Deploy del Worker live (usa il wrangler.production.toml)
wrangler deploy --config wrangler.production.toml
```

Questo crea un nuovo Worker chiamato `binance-trading-bot-live` su Cloudflare, completamente separato dal Worker testnet.

### 3.2 Imposta i Secrets

```bash
# BINANCE MAINNET API KEY (quella nuova, non testnet!)
wrangler secret put BINANCE_API_KEY --config wrangler.production.toml
# Incolla la tua API key mainnet

wrangler secret put BINANCE_API_SECRET --config wrangler.production.toml
# Incolla il tuo API secret mainnet

# Stessi del testnet
wrangler secret put WAVESPEED_API_KEY --config wrangler.production.toml
wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.production.toml
wrangler secret put TELEGRAM_CHAT_ID --config wrangler.production.toml
```

### 3.3 Verifica Connessione (BOT_ACTIVE=false)

Il bot e' deployato ma **spento** (`BOT_ACTIVE=false`). Verifica che si connette correttamente:

```bash
# Verifica health
curl https://binance-trading-bot-live.<tuo-account>.workers.dev/health

# Verifica connessione mainnet e balance
curl https://binance-trading-bot-live.<tuo-account>.workers.dev/account
```

Dovresti vedere:
```json
{
  "balance": "500.00000000",
  "unrealizedPnl": "0.00000000",
  "available": "500.00000000",
  "openPositions": 0,
  "positions": []
}
```

Se vedi il balance del tuo deposito, la connessione mainnet funziona.

### 3.4 Configura Telegram Webhook per il nuovo Worker

```bash
# Registra il webhook Telegram per il Worker live
curl -X POST https://binance-trading-bot-live.<tuo-account>.workers.dev/webhook/telegram/register
```

> **Nota:** Un bot Telegram puo' avere UN solo webhook. Se registri il webhook per il Worker live, il Worker testnet non ricevera' piu' i comandi Telegram. Tienilo presente.

### 3.5 Testa i Comandi Telegram

Manda `/status` su Telegram. Dovresti vedere:
- Environment: `production`
- Balance: il tuo deposito reale
- Bot Active: (croce rossa, perche' e' spento)

### 3.6 Accendi il Bot

Quando sei pronto:

1. Modifica `wrangler.production.toml`:
```toml
BOT_ACTIVE = "true"
```

2. Ri-deploya:
```bash
wrangler deploy --config wrangler.production.toml
```

Il bot iniziera' a tradare al prossimo ciclo cron (entro 5 minuti).

---

## Step 4: Monitoring Checklist (Prime 72 Ore)

Le prime 72 ore sono critiche. Monitora attivamente.

### Ogni 30 minuti (durante le ore di veglia)
- [ ] Controlla Telegram per notifiche di trade/errori
- [ ] Verifica che i messaggi "Cycle Report" arrivano ogni 5 minuti

### Ogni 2 ore
- [ ] Manda `/pos` per vedere le posizioni aperte
- [ ] Manda `/status` per verificare il balance
- [ ] Controlla sull'app Binance che gli ordini SL/TP sono piazzati

### Ogni 12 ore
- [ ] Manda `/perf` per il report completo
- [ ] Manda `/costs` per verificare i costi LLM
- [ ] Controlla i log con `wrangler tail --config wrangler.production.toml`

### Condizioni di STOP immediato
Disattiva il bot immediatamente se:
- [ ] **Drawdown > 5%** nelle prime 24 ore (perdita > $25 su $500)
- [ ] **Stesso errore ripetuto 3+ volte** nei log
- [ ] **Ordini SL/TP non piazzati** su Binance (verifica nell'app)
- [ ] **Balance scende sotto $450** (10% loss)
- [ ] **Trade su symbol inaspettato** (stablecoin, coppia non nella lista)

### Come disattivare in emergenza
```bash
# Opzione 1: wrangler (richiede ~30 secondi)
# Modifica wrangler.production.toml: BOT_ACTIVE = "false"
wrangler deploy --config wrangler.production.toml

# Opzione 2: Dashboard Cloudflare
# Workers > binance-trading-bot-live > Settings > Variables > BOT_ACTIVE = "false"

# Opzione 3: Binance (chiudi tutto manualmente)
# App Binance > Futures > Chiudi tutte le posizioni > Cancella tutti gli ordini
```

---

## Step 5: Scaling Plan

Aumenta gradualmente SOLO se le metriche restano positive.

| Settimana | Capitale | Max Position | Leverage | Risk/Trade | maxPositions |
|-----------|---------|-------------|----------|------------|-------------|
| 1-2       | $500    | $100        | 3x       | 1%         | 3           |
| 3-4       | $500    | $200        | 5x       | 1.5%       | 4           |
| 5-8       | $1,000  | $300        | 5x       | 2%         | 4           |
| 9+        | $2,000+ | $500        | 5-10x    | 2%         | 5           |

### Condizioni per scalare al livello successivo
- Sharpe Ratio > 1.0 per l'intero periodo precedente
- Win Rate > 52%
- Max Drawdown < 10% nel periodo
- Nessun errore critico nelle ultime 2 settimane
- Profit Factor > 1.3

### Come aggiornare i parametri

Modifica `src/index.ts` e ri-deploya:

```typescript
// Settimana 3-4
const config: EngineConfig = {
  // ...
  leverage: 5,
  riskPerTrade: 1.5,
  maxPositionSizeUsdt: 200,
  maxPositions: 4,
  // ...
};
```

```bash
wrangler deploy --config wrangler.production.toml
```

---

## Step 6: Rollback Procedure

Se qualcosa va storto, segui questi passi nell'ordine:

### 1. Spegni il bot
```bash
# Modifica wrangler.production.toml: BOT_ACTIVE = "false"
wrangler deploy --config wrangler.production.toml
```

### 2. Chiudi tutte le posizioni su Binance
- Apri l'app Binance
- Vai su Futures
- Premi "Close All Positions" (chiudi tutte)
- Premi "Cancel All Orders" (cancella tutti gli ordini SL/TP)

### 3. Verifica che tutto sia chiuso
```bash
curl https://binance-trading-bot-live.<tuo-account>.workers.dev/account
```

Deve mostrare `openPositions: 0`.

### 4. Analizza i log
```bash
wrangler tail --config wrangler.production.toml
```

Cerca:
- Errori ripetuti (`[Trade] Error:`, `[Engine] Cycle error:`)
- Ordini falliti (`Algo SL failed`, `Algo TP failed`)
- Risposte Binance anomale (`Binance 400:`, `Binance 403:`)

### 5. Decidi il prossimo passo
- **Bug nel codice:** fix, testa su testnet, poi ri-deploya su mainnet
- **Mercato avverso:** aspetta, non tradare con il bot in condizioni estreme
- **Performance scadenti:** torna su testnet e ri-ottimizza i parametri

---

## Differenze Testnet vs Mainnet

| Feature | Testnet | Mainnet |
|---------|---------|---------|
| URL API | `testnet.binancefuture.com` | `fapi.binance.com` |
| Algo orders SL/TP | Bugged su molti symbol | Funzionano correttamente |
| Orderbook depth | Sottile, alto slippage | Profondo, slippage minimo |
| Fill rate LIMIT | Inaffidabile | >95% con tolleranza 0.05% |
| API rate limits | Permissivi | Strict: 1200 req/min weight, 300 ordini/min |
| Commissioni | 0% | 0.02% maker / 0.04% taker |
| Fondi | Finti (testnet faucet) | Reali (il tuo deposito USDT) |
| exchangeInfo | Meno symbol disponibili | Tutti i perpetual USDT-margined |
| Hedge mode | A volte instabile | Stabile |
| Latenza API | Variabile | Bassa e consistente |

### Costo delle commissioni (stima)

Con $100 di position size e leverage 3x:
- **MARKET order:** 0.04% taker = $0.12 per trade (entry + exit = $0.24)
- **LIMIT order:** 0.02% maker = $0.06 per trade (entry + exit = $0.12)
- Con 10 trade/giorno: ~$1.20/giorno (LIMIT) vs ~$2.40/giorno (MARKET)
- Per mese: ~$36 (LIMIT) vs ~$72 (MARKET)

Ecco perche' usiamo LIMIT orders su mainnet.

### Rate Limits

Il bot attuale fa circa:
- 1 `exchangeInfo` per ciclo (se non cached): weight 40
- 1 `getAccountInfo` per ciclo: weight 5
- N `getKlines` per trade valutato: weight 5 ciascuno
- N `getPrice` per soft SL/TP: weight 1 ciascuno

Con cron ogni 5 minuti = 12 cicli/ora. Stima: ~200-500 weight/ora. Limite: 1200/minuto. **Siamo ampiamente nei limiti.**

---

## Checklist Finale

Prima di accendere `BOT_ACTIVE=true` su mainnet, verifica ogni punto:

### Performance Testnet
- [ ] Sharpe Ratio > 1.0 per almeno 2 settimane consecutive
- [ ] Win Rate > 52% su 200+ trade chiusi
- [ ] Max Drawdown < 15%
- [ ] Profit Factor > 1.3

### Configurazione Binance
- [ ] API key mainnet creata (diversa da testnet)
- [ ] Solo permesso Futures abilitato
- [ ] IP restriction configurata (o consapevolmente unrestricted)
- [ ] Hedge Mode attivato
- [ ] Cross Margin come default
- [ ] $500 USDT depositati nel wallet Futures

### Codice
- [ ] `wrangler.production.toml` creato con `ENVIRONMENT = "production"`
- [ ] Worker separato (`binance-trading-bot-live`)
- [ ] Secrets mainnet impostati (API key, API secret)
- [ ] Risk parameters conservativi (leverage 3x, risk 1%, max $100)
- [ ] Stablecoin filter aggiunto
- [ ] LIMIT orders al posto di MARKET (opzionale per Week 1)
- [ ] `startingBalance` aggiornato a $500

### Infrastruttura
- [ ] `/health` risponde OK
- [ ] `/account` mostra il balance mainnet corretto
- [ ] Telegram webhook registrato per il Worker live
- [ ] `/status` su Telegram funziona e mostra `production`

### Operativo
- [ ] Piano di rollback chiaro e testato mentalmente
- [ ] Notifiche Telegram attive (telefono non in silenzioso)
- [ ] App Binance installata sul telefono per chiusure manuali
- [ ] Le prossime 72 ore sono "normali" (no viaggi, no impegni che impediscono il monitoring)

---

## Note Finali

### Il Worker testnet resta attivo
Mantieni il Worker testnet (`binance-trading-bot`) attivo in parallelo. Usalo per:
- Testare nuove strategie prima di portarle su mainnet
- Testare aggiornamenti di codice
- Avere un benchmark di confronto

### Aggiornamenti futuri consigliati
1. **Persistenza con D1/KV:** salvare i trade in un database per `/perf` accurato
2. **Comando /stop via Telegram:** implementare un toggle runtime senza re-deploy
3. **Trailing stop:** muovere lo SL in profitto quando il trade va nella direzione giusta
4. **Fee tracking reale:** leggere le commissioni da Binance invece di stimarle
5. **Alert su drawdown:** notifica Telegram automatica se il drawdown supera una soglia

### Costi operativi mensili (stima)

| Voce | Costo |
|------|-------|
| Cloudflare Workers | $0 (free tier) |
| Workers AI (Llama 4 Scout) | $0 (free tier) |
| WaveSpeed AI (Haiku 4.5 + Sonnet 4.5) | ~$100/mese |
| Commissioni Binance | ~$36-72/mese (dipende dal volume) |
| Telegram | $0 |
| **Totale** | **~$136-172/mese** |

Per essere profittevole, il bot deve generare almeno **$200/mese** di profitto netto. Con $500 di capitale e i parametri conservativi iniziali, questo richiede un rendimento mensile del ~40%, che e' ambizioso. Man mano che scali il capitale, il breakeven diventa piu' raggiungibile.
