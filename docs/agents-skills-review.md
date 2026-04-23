# Agents & Skills Review — Phase B Deep Tuning

**Data**: 2026-04-21
**Contesto**: WR 73% nel primo round post-tuning (timeout 4h + TP 1.8x + anti-bounce SHORT), poi calato. Serve un'analisi più profonda del sentiment con verifica multi-timeframe per evitare di entrare quando il mercato sta già rimbalzando dalla notizia.

---

## 1. Stato attuale degli agenti

Tre agenti LLM, **tutti con lo stesso system prompt** e **tutti senza accesso al contesto multi-timeframe o alla storia recente del prezzo**.

### Agent 1: Batch Sensor
- File: [src/sentiment/llm-sensor.ts:111-182](src/sentiment/llm-sensor.ts#L111)
- Modello: Llama 4 Scout → GPT-OSS 20B
- Input: 5 news per batch, **solo testo**
- Output: `{asset, sentiment_score, confidence, magnitude, category}`
- **Cosa NON sa**: prezzo attuale, RSI, momentum, news precedenti sullo stesso asset, se la stessa notizia è già circolata

### Agent 2: High-Impact Sensor
- File: [src/sentiment/llm-sensor.ts:189-216](src/sentiment/llm-sensor.ts#L189)
- Modello: GPT-OSS 120B → 20B → Llama 4 Scout
- Input: singola news + timestamp
- Output: stesso JSON del batch
- **Cosa NON sa**: identico al batch, in più non sa se la notizia è "vecchia" (rumored da giorni)

### Agent 3: Strategist
- File: [src/trading/engine.ts:493-632](src/trading/engine.ts#L493)
- Modello: GPT-OSS 120B → 20B → Llama 4 Scout
- Input: composite score breakdown + indicators (1H) + ATR + regime + headline + storia D1
- Output: `{execute, reasoning, adjustedSL, adjustedTP, riskScore}`
- **Cosa NON sa**: il prezzo dell'asset 1h/4h/24h fa, i livelli di supporto/resistenza, se RSI è in divergenza, se la candela attuale ha già reagito alla notizia

### Indicatori tecnici
Tutti calcolati su **un solo timeframe (1H, 48 candele)** in [src/trading/engine.ts:416](src/trading/engine.ts#L416):
- RSI(14), ADX(14), ATR(14), MACD(12/26/9), BB(20/2), EMA20, Volume SMA(20)

**Nessuna analisi multi-timeframe.** Nessun confronto 5m/15m/1H/4H.

---

## 2. I problemi diagnosticati

### 2.1 Il sensor non distingue news fresca da news rimbalzata
Esempio reale del 20-04: Iran tensions, Aave hack — news vere ma **già scontate dal mercato**. Il sensor ha letto -0.85 confidence 0.96, lo strategist ha shortato, il prezzo era già al floor → bounce → stop loss.

**Il filtro anti-bounce attuale** ([event-driven.ts:103-111](src/trading/strategies/event-driven.ts#L103)) blocca SHORT con RSI<35 OR vol<0.5, ma è una pezza grossolana. Non guarda:
- L'asset si sta già muovendo nella direzione giusta? (se sì, sentiment confermato)
- C'è divergenza tra RSI e prezzo? (segnale di esaurimento)
- Sul timeframe 4H il trend è opposto? (controtrend = trappola)

### 2.2 Il sensor non vede la storia recente
Stessa notizia diffusa da 5 fonti diverse → 5 segnali con stesso punteggio bearish → composite score si rinforza artificialmente. Nessun de-duplication semantica, solo per ID.

### 2.3 Il sensor non considera l'aging della notizia
"Aave hack triggered crisis" può essere news di 1h fa (prezzo non ha reagito) o di 24h fa (prezzo già crollato e rimbalzato). Il sensor riceve `publishedAt` ma il system prompt non lo usa per ragionare.

### 2.4 Lo strategist riceve indicatori ma non timeseries
Riceve "RSI=42, ADX=28, vol=2.1x" ma non sa:
- Il prezzo come si è mosso negli ultimi 5 min / 15 min / 1h / 4h?
- C'è un livello chiave (resistenza/supporto) vicino?
- Il volume è in crescita o in calo?

### 2.5 Tutti e 3 gli agenti hanno temperature uniformi
Sensor 0.05, Strategist 0.3 — ragionevoli ma il sensor dovrebbe avere libertà di "ragionare" prima di outputtare il JSON quando la news è ambigua.

---

## 3. Proposte concrete (in ordine di impatto stimato)

### Proposta A — Multi-timeframe price snapshot al sensor (HIGH impact)

Aggiungere al payload del sensor (sia batch che high) un **price snapshot** dell'asset menzionato:

```
PRICE CONTEXT for ETH:
- Current: $2280
- 5m ago: $2275 (+0.2%)
- 1h ago: $2310 (-1.3%)
- 4h ago: $2295 (-0.7%)
- 24h ago: $2380 (-4.2%)
- 24h volume: 1.2x average
```

**Cosa cambia nel prompt**: aggiungere alle CRITICAL RULES:
> "If the price has ALREADY moved >3% in the news direction in the last 4h, REDUCE magnitude by 0.4. If price is moving OPPOSITE to the news (bounce), set sentiment_score closer to 0 — the market has rejected the news."

**Costo**: +1 fetch klines (5m, 1h, 4h timeframe) per asset menzionato per news. Cache 1 min in KV.

### Proposta B — Multi-timeframe technical confirmation al strategist (HIGH impact)

Lo strategist riceverebbe **3 timeframe** invece di 1:

```
INDICATORS for ETH:
- 15m: RSI=38, MACD bearish, BB lower band breach
- 1h:  RSI=42, MACD bullish cross, BB middle
- 4h:  RSI=51, MACD neutral, EMA20 above price
- Trend alignment: 15m bearish, 1h bullish, 4h neutral → MIXED
```

Nuova regola nel prompt: "If timeframes disagree (mixed alignment), reduce position size to 0.5x or skip. Trade only when 2+ timeframes confirm direction."

**Implementazione**: [src/trading/engine.ts:416](src/trading/engine.ts#L416) deve fetchare anche 15m e 4h candles. Computare RSI/MACD/EMA su tutti e 3.

### Proposta C — News dedup semantico + aging (MEDIUM impact)

Prima di passare al sensor:
1. **Hash semantico**: titolo lemmatizzato + asset = chiave dedup (non solo ID)
2. **Aging tag**: se notizia simile è apparsa nelle ultime 6h, taggare come `RECYCLED` e ridurre magnitude di default a 0.3
3. Passare al sensor il numero di volte che la notizia è circolata: "This story appeared in 3 sources over the last 2h"

### Proposta D — Reasoning step prima del JSON (MEDIUM impact)

Cambiare il prompt del sensor da "Output ONLY JSON" a:

```
Step 1 - Analyze: brief 2-line analysis of the news
Step 2 - Check: is this fresh or already known/priced?
Step 3 - Output JSON
```

Mantenendo temperature 0.05 e max_tokens 512, costa solo ~50 token in più ma aumenta qualità sensibilmente. Estrarre il JSON con regex `\{[\s\S]*\}` (già fatto).

### Proposta E — Strategist: divergence detector (MEDIUM impact)

Aggiungere al payload dello strategist:
```
DIVERGENCE CHECK:
- RSI vs Price: RSI rising while price falling → bullish divergence (skip SHORT)
- Volume vs Price: volume falling while price falling → weak trend (likely bounce)
```

Calcolare divergenza confrontando ultimo high/low di RSI vs prezzo nelle ultime 12 candele 1H.

### Proposta F — Pattern di rimbalzo storico (LOW impact)

Quando lo strategist valuta uno SHORT, query D1: "Quanti SHORT su questo asset in questo regime hanno fatto stop loss negli ultimi 7 giorni?". Se >60% → skip o size 0.3x.

Già parzialmente implementato in `getPatternStats` ma non sempre passato al prompt.

### Proposta G — Modello dedicato per news classification (LOW impact, EXPERIMENTAL)

Test di un modello specializzato in finance: vedere se Workers AI ha qualcosa tipo `@cf/.../finbert` o simili. Fallback a GPT-OSS resta.

---

## 4. Roadmap di implementazione consigliata

### Sprint 1 ✅ DEPLOYED (2026-04-21)
- **Proposta A** ✅ — price snapshot al sensor HIGH (5m/1h/4h/24h + volume ratio)
- **Proposta B** ✅ — multi-timeframe confirmation allo strategist (1h + 4h)
- **Proposta D** ✅ — reasoning workflow 4-step nel sensor prompt
- **Trend-reversal early-exit** ✅ (follow-up Sprint 1, 2026-04-21) — chiude posizioni profittevoli quando il trend si gira

**Scope deciso**:
- Price context applicato solo a `processHighImpactItem` (NON al batch sensor) — limita il costo a ~3-5 fetch klines per ciclo invece di 30
- Strategist su 2 timeframe (1h + 4h), NON 3 — il 4h dà la marea, l'1h dà l'entry timing; il 15m è rumore per holding di 4h

**Implementazione (~250 righe modificate)**:
- [src/sentiment/llm-sensor.ts](src/sentiment/llm-sensor.ts) — nuova `PriceContext` interface, `formatPriceContext`, `SYSTEM_PROMPT_HIGH` con regole price-aware + 4-step reasoning, `processHighImpactItem` accetta priceContext opzionale
- [src/trading/engine.ts](src/trading/engine.ts) — `quickIdentifyAsset()` (dictionary-based pre-identify), `buildPriceContext()` (fetch parallelo 5m+1h klines, calcola pct change), prompt strategist arricchito con blocco `MULTI-TIMEFRAME ANALYSIS` (RSI/ADX/MACD/EMA20 su 1h+4h, label ALIGNMENT esplicito), system prompt strategist aggiornato con priorità TOP su reject COUNTER-TREND e MIXED+score<75
- maxTokens strategist 512 → 768 per accomodare il prompt cresciuto

**Trend-reversal early-exit** ([src/trading/engine.ts](src/trading/engine.ts)) — `checkTrendReversal(symbol, direction, currentPrice)`:
- Attivazione: posizione con PnL > 0 AND held ≥60min
- Bilanciato: chiude se **2 su 3** segnali tecnici si sono girati contro la direzione:
  1. MACD histogram flipped (bullish→bearish per LONG, viceversa per SHORT)
  2. RSI cross 50 contrario
  3. Prezzo cross EMA20 contrario
- Priorità check: trend-reversal → timeout → SL/TP
- Obiettivo: proteggere i profitti delle posizioni che stanno decadendo verso il break-even prima del timeout di 4h
- Log Telegram: `Trend reversal (MACD+EMA20, profit $0.15 locked)`

**KPI da misurare nei prossimi 3 giorni (target ~20-30 trade)**:
1. % trade rejected con motivo `COUNTER-TREND` — deve esistere (segnale che MTF funziona)
2. % trade rejected con motivo `MIXED + composite<75` — deve esistere
3. WR generale — target +10-15% rispetto al baseline (era 73% poi calato)
4. Avg loss per SHORT — target sotto -$0.06 (era -$0.10)
5. % trade chiusi al timeout — deve restare sotto 30% (era 82% pre-Sprint-0, 45% post-Sprint-0)
6. % trade chiusi per `Trend reversal` — nuovo motivo di chiusura, deve apparire e proteggere profitti vs timeout-a-zero
7. Avg win per trade chiuso da trend-reversal vs avg win timeout — il trend-reversal dovrebbe lockare profitti più alti

### Sprint 2 (raffinamento) — DA FARE dopo validazione Sprint 1
- **Proposta C** — dedup semantico + aging
- **Proposta E** — divergence detector

Stima: 1-2 giorni di implementazione, +5% WR atteso.

### Sprint 3 (consolidamento)
- **Proposta F** — pattern storico più aggressivo
- **Proposta G** — sperimentazione modelli alternativi

---

## 5. Cosa misurare per validare

Prima di considerare "fatto" qualunque sprint:
1. **WR su 30+ trade post-deploy** (sample minimo statisticamente decente)
2. **% trade chiusi al timeout** vs % che colpisce TP — deve scendere sotto 30%
3. **% trade in controtrend (LONG quando 4H è ribassista)** — deve azzerarsi
4. **Avg loss per side**: gli SHORT che oggi perdono in media -$0.10 devono scendere a -$0.06
5. **Confronto pre/post sui pattern di "news vecchia"**: cercare manualmente 5 esempi e vedere se ora il sistema le scarta

---

## 6. Decisione richiesta

Prima di implementare, conferma:
1. Partiamo dallo **Sprint 1** (A+B+D)? O preferisci un sottoinsieme?
2. Per Proposta A: il fetch del price snapshot lo facciamo **per ogni news che il sensor riceve**, o solo per le HIGH-impact?
3. Per Proposta B: tre timeframe (15m + 1h + 4h) o due (1h + 4h)? Tre raddoppia le chiamate exchange.
