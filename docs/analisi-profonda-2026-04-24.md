# Analisi Profonda — Verso WR 60% sostenibile

**Data**: 2026-04-24
**Periodo analizzato**: 2026-04-19 → 2026-04-24 (58 trade chiusi)
**WR attuale**: 46.6% (27W / 31L) — **target: 60%+**
**PnL cumulato**: -$0.52

---

## 1. Performance per giorno

| Giorno | Trade | WR | PnL | Avg hold |
|---|---|---|---|---|
| 19 | 3 | **100%** | +$0.20 | 2.08h |
| 20 | 13 | 38.5% | -$0.30 | 2.28h |
| 21 | 21 | 42.9% | -$0.29 | 2.76h |
| 22 | 11 | **54.5%** | +$0.21 | 3.09h |
| **23** | **7** | **14.3%** | **-$0.43** | 2.28h |
| 24 (parziale) | 3 | 66.7% | +$0.09 | 2.25h |

**Lettura**: tre cluster — i giorni 19/22/24 sono "in target", il 23 è disastro, gli altri sono in linea con WR ~40%. Non c'è degrado progressivo, c'è **inconsistenza**.

---

## 2. Pattern critici trovati

### 2.1 SHORT con RSI 35-45 = MORTE
Questo è il **pattern più costoso** in assoluto:

| Direction | RSI bucket | n | WR | PnL |
|---|---|---|---|---|
| SHORT | <35 (oversold) | 4 | 75% | -$0.06 |
| **SHORT** | **35-45** | **15** | **33.3%** | **-$0.65** |
| SHORT | 45-55 | 4 | 25% | -$0.15 |
| SHORT | 55-65 | 2 | 50% | +$0.34 |

**15 trade SHORT su 26 totali (58%)** sono entrati con RSI tra 35-45, e hanno perso $0.65 → **questo singolo bucket spiega +120% del PnL negativo SHORT**.

Il filtro anti-bounce attuale blocca solo RSI<35. Tutto il "low neutral" 35-45 passa, ma in pratica è ancora **zona di rimbalzo**: il market ha già scontato la news bearish, chi entra short si becca il bounce.

### 2.2 LONG vincono solo quando RSI è ALTO (non basso)

| Direction | RSI bucket | n | WR | PnL |
|---|---|---|---|---|
| LONG | 35-45 | 2 | 0% | -$0.20 |
| LONG | 45-55 | 8 | 50% | -$0.03 |
| LONG | 55-65 | 17 | 41% | +$0.05 |
| **LONG** | **>65 (overbought)** | **5** | **80%** | **+$0.16** |

**Sorpresa**: i LONG migliori sono quelli su asset **già in trend forte** (RSI>65), non quelli che provano a "comprare il dip" (RSI<50). I LONG con RSI 35-45 perdono il 100% delle volte.

### 2.3 Holding 2h-zone è il timeout killer

| Direction | Bucket | n | WR | PnL |
|---|---|---|---|---|
| SHORT | 1.5-2.3h (timeout vecchio) | 16 | 43.8% | **-$0.43** |
| LONG | 2.3-4.5h (timeout nuovo) | 19 | 52.6% | +$0.06 |

I trade SHORT che chiudono nella zona 2h hanno il PnL peggiore. Ma quelli LONG nella zona 4h vanno bene. Probabile che gli SHORT continuino a essere chiusi al "vecchio" timeout di 2h che era ancora attivo per le posizioni aperte prima del cambio.

### 2.4 Asimmetria F&G: SHORT in EXTREME_FEAR è errore

| Direction | F&G | n | WR | PnL |
|---|---|---|---|---|
| LONG | EXTR_FEAR (<30) | 5 | **80%** | +$0.20 |
| **SHORT** | EXTR_FEAR (<30) | **14** | **50%** | -$0.14 |
| SHORT | FEAR (30-50) | 12 | 33.3% | -$0.36 |

**EXTREME_FEAR è bullish per i LONG (80% WR)**, ma il sistema apre **14 SHORT** in EXTREME_FEAR (50% WR) e **12 SHORT in FEAR** (33% WR). La regime adjustment esiste ma non è abbastanza aggressiva nel **bloccare gli SHORT in mercato già paniccato**.

### 2.5 Lo Sprint 1 ha cambiato il regime più che il WR

Confronto 19-21 (pre-Sprint 1) vs 22-24 (post-Sprint 1):

| Periodo | n | WR | PnL | Avg hold |
|---|---|---|---|---|
| Pre (19-21) | 37 | 45.9% | -$0.39 | 2.49h |
| Post (22-24) | 21 | 42.9% | -$0.13 | 2.71h |

Post-Sprint 1 il PnL si è dimezzato (buono), ma il WR è leggermente sceso. **Lo Sprint 1 ha ridotto l'ampiezza delle perdite ma non la loro frequenza**. Coerente con l'idea: il MTF filter scarta i "counter-trend" più estremi, ma non interviene sul pattern RSI 35-45.

---

## 3. Diagnosi dei punti critici

### 3.1 Il filtro anti-bounce è troppo permissivo
**Adesso**: `SHORT && RSI<35 → reject`
**Dovrebbe essere**: `SHORT && RSI<45 → reject` (estendi a 45) — i dati mostrano che il 33% WR di RSI 35-45 è statisticamente inaccettabile.

### 3.2 Manca un filtro pro-momentum per i LONG
**Adesso**: nessun gate RSI minimo per LONG (solo RSI>75 = block)
**Dovrebbe essere**: `LONG && RSI<45 → reject` — i dati mostrano 0% WR su 2 trade. Sample piccolo ma il segnale è netto.

### 3.3 Regime EXTREME_FEAR non blocca abbastanza SHORT
**Adesso**: regime adjusta size/leverage, ma non blocca direzioni
**Dovrebbe essere**: `SHORT && F&G<35 → reject` — 14 SHORT con WR 50% sembra ok ma il loss avg ($0.10) è 4x il win avg. Inoltre i LONG in EXTREME_FEAR vincono 80% — qui il sistema deve essere asimmetrico.

### 3.4 Trend-reversal early-exit non si vede nei dati
Devo verificare se ha mai sparato. Se mai → bug. Se sì ma raro → soglia troppo conservativa (2/3 segnali).

### 3.5 Lo strategist LLM non è abbastanza severo
Approva troppi trade. Il MTF block del system prompt è chiaro ma il modello tende a "trovare sempre una giustificazione" per approvare. Servirebbe **una checklist binaria forzata** invece di lasciare al modello la libertà di reasoning.

### 3.6 Cooldown post-loss è troppo breve
**Adesso**: 1h dopo loss
**Dovrebbe essere**: 2-3h dopo loss, **per asset** — se BTC va male SHORT alle 14:00, alle 15:00 entriamo di nuovo SHORT BTC con stessi indicatori e ri-perdiamo. Vediamolo nei dati: ETH SHORT alle 14:06 -$0.04 → ETH SHORT alle 19:40 -$0.08 stesso giorno → consecutivi cattivi.

---

## 4. Proposte di intervento (in ordine di impatto stimato)

### Proposta 1 — Estendi anti-bounce a RSI<45 per SHORT (HIGH impact, LOW risk)
Cambia 1 riga in [event-driven.ts:103](src/trading/strategies/event-driven.ts#L103). Elimina il pattern più costoso. **Aspettativa: -$0.50 di loss eliminata, WR SHORT da 33% → 60%+.**

### Proposta 2 — Aggiungi pro-momentum filter per LONG (RSI≥45) (MEDIUM impact, LOW risk)
Aggiungi gate simmetrico in event-driven.ts. Solo 2 trade nei dati ma 0% WR è un segnale chiaro.

### Proposta 3 — Asimmetria regime: blocca SHORT in EXTR_FEAR (HIGH impact, MEDIUM risk)
Aggiungi al gate composite-score: `if direction==SHORT && fearGreed<35 → reject`. Mantieni LONG in EXTR_FEAR (80% WR).

### Proposta 4 — Cooldown per-asset esteso a 2h (MEDIUM impact, LOW risk)
Cambia il cooldown da 1h a 2h e aggiungi un secondo gate "no same asset+direction in last 4h regardless of P&L". Previene loop di re-entry sullo stesso pattern.

### Proposta 5 — Strategist con checklist binaria forzata (MEDIUM impact, MEDIUM risk)
Riscrivi il prompt strategist con scoring esplicito: 5 domande binarie, serve almeno 4/5 SI per approvare. Riduce la libertà del modello di "razionalizzare" approvazioni deboli.

### Proposta 6 — Verifica trend-reversal (DEBUG, LOW risk)
Aggiungi un endpoint `/debug/last-reversals` o un log strutturato per capire se mai si è attivato. Se mai, il check ha un bug.

### Proposta 7 — Consensus su 2 fonti per HIGH-impact (LOW impact, HIGH effort)
Per le notizie HIGH, richiedi che almeno 2 fonti diverse riportino la stessa notizia entro 30 min prima di tradare. Riduce trades su single-source rumor che si rivelano fake.

---

## 5. Roadmap suggerita

### Sprint 2A — Filtri RSI hard (deploy oggi)
- Proposta 1 (anti-bounce SHORT esteso)
- Proposta 2 (pro-momentum LONG)
- Proposta 3 (regime asimmetria SHORT)

Stima: 30 min, 3 file modificati. **Aspettativa WR: 47% → 58-62%** sui prossimi 30 trade.

### Sprint 2B — Stabilità (deploy 2 giorni dopo, dopo validazione)
- Proposta 4 (cooldown esteso)
- Proposta 6 (debug trend-reversal — fixare se rotto)

### Sprint 2C — Qualità (dopo validazione 2A+2B)
- Proposta 5 (checklist binaria strategist)
- Proposta 7 (consensus 2-source — solo se ancora servisse)

---

## 6. Sull'affidabilità 99%

Il "WR 60% con affidabilità 99%" è statisticamente possibile ma richiede:
- **Sample minimo**: per dire con CI 99% che il WR vero è ≥60%, servono ~150-200 trade osservati con WR misurato ≥66%. Ad oggi 58 trade non sono sufficienti per una statistica forte.
- **Stabilità del processo**: i parametri non possono cambiare ogni giorno o il campione si fraziona. Dopo Sprint 2A bisogna lasciar girare almeno 5-7 giorni senza modifiche.
- **Regime market**: WR cambia con il regime. EXTREME_FEAR ha tendenze diverse da GREED. Il "60% affidabile" si applica solo se il bot opera in regime simile al training.

**Realismo**: target Sprint 2A = WR 55-60% sui prossimi 30 trade. Se confermato, si va a 65% Sprint 2B. Solo dopo 2 settimane di stabilità a 60%+ possiamo parlare di affidabilità statistica.

---

## 7. Decisione richiesta

Confermi che procediamo con **Sprint 2A (Proposte 1+2+3)**? Sono cambi minimi (poche righe) ma colpiscono i 3 pattern peggiori identificati dai dati. Dopo il deploy, lasciamo girare 3 giorni e rivalutiamo.
