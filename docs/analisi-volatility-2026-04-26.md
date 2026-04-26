# Analisi — Cosa NON viene controllato prima di tradare

**Data**: 2026-04-26
**Scenario**: 2 BTC LONG aperti il 25/04 in mercato range (ADX<20, ATR<0.3%), entrambi falliti per timeout 4h con perdita $0.05 totale.

---

## 1. I due trade sotto la lente

| Trade | RSI | **ADX** | **ATR%** | Vol ratio | F&G | PnL | Esito |
|---|---|---|---|---|---|---|---|
| BTC LONG 25/04 10:50 | 54.3 | **9.6** | **0.22%** | 0.70 | 31 | -$0.014 | timeout 4h |
| BTC LONG 25/04 23:35 | 50.4 | **18.6** | **0.24%** | 0.53 | 31 | -$0.035 | timeout 4h |

Entrambi hanno fallito perché:
- **ADX <20** = mercato senza trend, BTC stava lateralizzando
- **ATR molto basso (<0.3%)** = ampiezza candele insufficiente per coprire un TP a 1.8x ATR in 4h
- **Volume sotto media** = nessuno comprava per davvero, solo rumore
- **F&G 31 (FEAR)** = sentiment macro negativo, news positive isolate vengono assorbite

---

## 2. Cosa il sistema controlla davvero PRIMA di entrare

### 2.1 Gate hard (bloccano l'ingresso)
File: [src/trading/strategies/event-driven.ts](src/trading/strategies/event-driven.ts) + [src/trading/engine.ts](src/trading/engine.ts)

| # | Gate | Soglia | Cosa misura |
|---|---|---|---|
| G1 | Magnitude LLM | ≥ 0.5 | Quanto la news dovrebbe muovere il prezzo |
| G2 | Confidence LLM | ≥ 0.7 | Quanto il classificatore è sicuro |
| G3 | Sentiment direzione | \|score\| ≥ 0.3 | Direzione netta, non neutrale |
| G4 | RSI range | LONG <75, SHORT >25 | Estremi assoluti |
| G5 | Move recente | <6% in 3 candele | News non già scontata |
| G6a | Anti-bounce SHORT | RSI ≥ 45 | Evita short-squeeze trap |
| G6b | Pro-momentum LONG | RSI ≥ 45 | Evita catch-falling-knife |
| G6c | Anti-bounce vol | SHORT vol ≥ 0.5 | Conferma panic-sell |
| G7 | F&G asimmetria | SHORT bloccato se F&G<35 | Asimmetria regime |
| G8 | Volume 24h | ≥ $2M | Liquidità minima |
| G9 | Cooldown loss | 1h dopo loss su asset | No revenge trade |
| G10 | Multi-timeframe | reject COUNTER-TREND, MIXED+score<75 | 1h vs 4h alignment |
| G11 | Composite score | ≥ 60 | Voto multifattoriale |

### 2.2 Cosa NON c'è (ed è il problema attuale)

| Indicatore | Calcolato? | Usato come gate? | Problema |
|---|---|---|---|
| **ADX** | ✅ | ❌ (solo "trend bonus" +0.1) | Si entra in mercati senza trend (ADX 9!) |
| **ATR%** | ✅ (in volatility score) | ❌ (solo dimensiona SL/TP) | Si entra con ATR 0.22% = TP irraggiungibile in 4h |
| **Volume LONG** | ✅ | ❌ (solo SHORT ha gate vol) | LONG con volume 0.53 (no domanda) passano |
| **F&G LONG** | ✅ | ❌ | LONG in EXTR_FEAR (F&G<30) hanno WR 80% storico ma in FEAR (30-50) WR 41% |
| **EMA distance** | ✅ | ❌ (solo "trend bonus") | Non controlla se siamo a fair distance dal trend |
| **Bollinger position** | ✅ (in volatility score) | ❌ | Score impatta ma non blocca |

### 2.3 Il composite score "annacqua" i problemi

Il composite-score combina 5 fattori pesati:
- Sentiment 25% + Momentum 25% + **Volatility 20%** + Trend 15% + Regime 15%

Quindi un trade può passare il gate 60/100 anche se il fattore Volatility è basso, perché Sentiment+Momentum (50% del peso) sono alti. **Il sistema non rifiuta esplicitamente "ATR troppo basso" o "ADX troppo basso"**, li media nel mucchio.

Esempio del trade BTC #1:
- Sentiment forte → 70+
- Momentum (RSI 54 vicino al 50, OK) → 50
- **Volatility bassa (ATR 0.22%, vol 0.7) → 30**
- Trend (ADX 9 = nessuno) → 30
- Regime (F&G 31, neutrale per LONG) → 50

Score finale ≈ `70*0.25 + 50*0.25 + 30*0.20 + 30*0.15 + 50*0.15` = **52** 

Ma probabilmente con weights diversi è andato a 60+ (Sentiment ancora più forte? Momentum boostato dalla news?). Servirebbe il debug del singolo trade per saperlo certo, ma il problema è strutturale.

---

## 3. Il punto chiave sulla volatilità

**Stiamo valutando la volatilità?** Sì, ma in modo errato:

1. **ATR viene calcolato e MOLTIPLICATO per 1.5 / 1.8 → SL e TP**
2. **Ma se ATR è $188 su BTC a $77,756 = 0.24%**, il TP è solo $77,756 + 188×1.8 = $78,094 → 0.43% di movimento
3. In 4h, BTC con ADX 9 difficilmente fa 0.43% perché lateralizza
4. → **timeout, perdita per fees**

**Il problema reale**: SL/TP scalano con ATR, ma il timeout (4h) è fisso. Quindi in mercati a bassa volatilità il TP non viene mai colpito perché non c'è abbastanza movimento nel tempo dato.

---

## 4. Proposte chirurgiche (in ordine di impatto)

### Proposta 1 — Gate hard: minimo ADX 18 (HIGH impact)
Aggiungere a [event-driven.ts](src/trading/strategies/event-driven.ts):
```ts
if (adxRes.adx < 18) {
  return reject(symbol, `Trend troppo debole (ADX=${adxRes.adx.toFixed(0)}<18)`, indicators);
}
```
Avrebbe bloccato entrambi i 2 trade BTC del 25 aprile.

### Proposta 2 — Gate hard: minimo ATR% 0.4% (HIGH impact)
```ts
const atrPct = (atr / currentPrice) * 100;
if (atrPct < 0.4) {
  return reject(symbol, `Volatilità insufficiente (ATR=${atrPct.toFixed(2)}%<0.4% per TP raggiungibile)`, indicators);
}
```
Soglia 0.4% perché TP 1.8x ATR = 0.72% movimento richiesto, ragionevole in 4h se c'è anche solo trend debole.

### Proposta 3 — Gate hard: volume ratio anche per LONG (MEDIUM impact)
Adesso solo SHORT ha gate vol. Aggiungere:
```ts
if (direction === 'LONG' && volumeRatio < 0.7) {
  return reject(symbol, `LONG vol troppo basso (${volumeRatio.toFixed(2)}x = no buying pressure)`, indicators);
}
```
Soglia 0.7 (più permissivo del SHORT 0.5) perché i LONG hanno bisogno di domanda confermata, mentre uno SHORT può funzionare anche senza panic-sell.

### Proposta 4 — Cap del LONG in FEAR macro (MEDIUM impact)
Adesso solo SHORT è bloccato in EXTR_FEAR (F&G<35). Per i LONG, aggiungere boost composite-score richiesto:
```ts
if (direction === 'LONG' && fearGreed < 35 && composite.score < 75) {
  return reject(symbol, `LONG in FEAR richiede composite≥75 (attuale ${composite.score})`, indicators);
}
```
Lascia passare i LONG eccezionali (score≥75) in EXTR_FEAR (storia: 80% WR), ma blocca quelli mediocri.

### Proposta 5 — Adjust dinamico timeout su ATR% (LOW-MED impact)
Se ATR% è basso (0.4-0.6%), allunga il timeout a 6-8h. Se ATR% è alto (>1.5%), accorcia a 2-3h. Codice in event-driven.ts:
```ts
timeoutHours: atrPct < 0.6 ? 6 : atrPct > 1.5 ? 3 : 4
```

### Proposta 6 — Trend reversal anche in perdita lieve (LOW impact)
Adesso il trend-reversal early-exit funziona solo `pnl > 0`. Considerare anche `pnl > -$0.05 && heldMin > 90` per chiudere prima che la perdita peggiori.

---

## 5. Roadmap proposta

### Sprint 2B (deploy oggi)
- **Proposta 1** — Gate ADX≥18
- **Proposta 2** — Gate ATR%≥0.4%
- **Proposta 3** — Gate volume LONG≥0.7

3 righe di codice, attaccano direttamente il problema diagnosticato. Aspettativa: zero trade in mercati range/illiquidi → meno timeout → meno fees.

### Sprint 2C (dopo validazione 2B)
- **Proposta 4** — Cap LONG in FEAR
- **Proposta 5** — Timeout dinamico

### Sprint 2D (refinement)
- **Proposta 6** — Trend-reversal in perdita lieve

---

## 6. Decisione richiesta

Procedo con **Sprint 2B (proposte 1+2+3)**? Sono cambi minimi, fail-closed (bloccano in caso di dubbio), e attaccano direttamente i 2 trade falliti del 25/04.
