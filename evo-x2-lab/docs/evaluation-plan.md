# Piano di valutazione — bake-off modelli e A/B della collaborazione

Le decisioni di produzione si prendono **solo qui, sui dati tuoi**. La
letteratura 2026 è unanime sul lab-to-real gap: GPT-4 sfrutta l'87% dei
one-day CVE *con la descrizione dell'advisory*, ma gli agenti risolvono solo
il 13% dei CVE reali (CVE-Bench) e ~0% delle challenge HTB difficili. Benchmark
di marketing e README dei vendor non contano: contano i PoC eseguiti.

## 1. Domande a cui rispondere

1. **Bake-off slot "cyber"**: Deep Hat V2 30B regge davvero contro un
   generalista forte (Qwen-3.5-27B)? E contro la base + prompt ben fatti?
2. **Guadagno della collaborazione**: l'ensemble generator→critic e il
   best-of-k valgono la latenza in più rispetto al worker solo?
3. **Soglie di produzione**: quali modelli entrano nello stack stabile?

## 2. Modelli in gara

| ID | Modello | Ruolo in gara | Famiglia |
|---|---|---|---|
| A | Deep Hat V2 30B (Q4) | critic + knowledge cyber | "nato cyber" (WhiteRabbitNeo/Kindo) |
| B | Qwen-3.5-27B (Q4) | generalista mid-tier | Qwen |
| C | Qwen3-Coder-Next (Q4) | generator | Qwen MoE |
| D | gpt-oss-20B (MXFP4) | executor/tool caller | OpenAI MoE |
| E | OpenMythos (baseline cyber) | confronto | fine-tune cyber |
| F | CyberSecQwen-4B | solo triage difensivo | Qwen FT difensivo |

Vincolo architetturale da verificare nella gara: **critic di famiglia diversa
dal generator** (A-C o B-C, mai C-C).

## 3. Livelli di challenge (dal più facile al più realistico)

Ispirati al protocollo TrustedSec di benchmark su LLM self-hosted per
offensive security: si parte semplice e si sale, così si vede *dove* un
modello decade, non solo *se* fallisce.

| Livello | Ambiente | Cosa misura |
|---|---|---|
| L0 | Challenge naive isolate (es. 6 setup intenzionalmente semplici, stile TrustedSec) | basi: tool use, syntax, no-regression |
| L1 | vulnbank.org (o webgoat/DVWA) | web vuln end-to-end, exploit validation |
| L2 | PicoCTF / OverTheWire (subset prelevato, 20-30 challenge) | crypto, rev, pwn, forensics leggeri |
| L3 | HackTheBox: 5 macchine live di difficoltà nota | l'agente reale: chaining, multi-stage |
| L4 | Report: partire dai finding di una vecchia engagement (anonimizzata) | qualità della sintesi e del report |

Regole di gara uguali per tutti: stesso harness (CAI), stessi tool, stesso
budget (max 200K token e 30 min per target, k=1 salvo diversa indicazione),
temperature fissata, nessun accesso a risposte.

## 4. Metriche

| Metrica | Definizione | Perché |
|---|---|---|
| **exploit rate** | % di target con PoC eseguito con successo | l'unica che conta: finding validati, non ipotizzati |
| **pass@k** | probabilità che almeno 1 di k tentativi indipendenti vinca | misura il guadagno del best-of-k |
| **false negative** | target "non sfruttabile" dichiarati ma in realtà vulnerabili | il costo reale per il cliente |
| **false positive** | PoC proposti che falliscono l'esecuzione | rumore nei report; misura la qualità del Generator |
| **critic accuracy** | % di failure_modes del Critic confermati dall'esecuzione | se il critic sbaglia sempre, è overhead |
| **tok/s e min/finding** | throughput e tempo per finding validato | capacità operativa della startup |
| **token/finding** | costo computazionale per finding validato | margine economico |

## 5. A/B della collaborazione

Su un sottoinsieme fisso (L1 + L2, ≥15 target) girano **tre configurazioni**:

| Braccio | Configurazione | Ipotesi |
|---|---|---|
| control | worker solo (k=1) | baseline |
| trattamento 1 | generator→critic→judge | −false positive, +qualità PoC |
| trattamento 2 | best-of-k (k=3) + judge | +exploit rate (Novee: 63→87% pass@k) |

Decision rule (pre-impostata, per non improvvisare dopo i risultati):
- un braccio entra in produzione solo se **exploit rate +5pp** o
  **false positive −30%** a fronte di **latenza ≤ 2×** il controllo;
- altrimenti resta in produzione il worker solo e il budget risparmiato
  si investe in più tentativi sul livello successivo.

## 6. Criteri di accettazione per slot (produzione)

| Slot | Criterio minimo |
|---|---|
| coder (Generator) | exploit rate L1 ≥ 60%, false positive ≤ 25% |
| cyber (Critic) | critic accuracy ≥ 70%, altrimenti si ricade su Qwen-3.5-27B |
| toolcaller | 100% chiamate tool conformi allo schema MCP, 0 esecuzioni fuori sandbox |
| parser | finding extraction: ≤ 5% di evidenze perse sull'output di riferimento |
| brain | accettazione dei piani umani ≥ 80% in review cieca |

Uno slot che non passa resta in "sperimentale" (mai nelle engagement dei
clienti) finché non cambia il risultato.

## 7. Procedura operativa

1. Preparare gli ambienti (L0-L3) con flag `isolated`: snapshot ripristinabili.
2. Per ogni target e braccio: girare la sessione con audit trail completo
   (ogni comando eseguito loggato — pattern Nebula; serve anche come evidenza
   per i clienti istituzionali).
3. Validazione: ogni finding passa da **esecuzione reale** del PoC in sandbox
   (pattern Strix). Solo PoC eseguiti con successo contano come exploit rate.
4. Compilare la riga CSV di sintesi (stesso formato di scripts/benchmark.sh).
5. Ripetere ogni gara **3 volte** (seed diversi) e riportare media ± range:
   i benchmark single-run su LLM sono rumore.

## 8. Template report per cliente (bozza da validare in L4)

1. Executive summary (rischio per il business, non tecnicismi)
2. Perimetro e metodo (con dichiarazione di uso di strumenti AI assistiti —
   richiesta trasparenza verso le istituzioni)
3. Finding validati: descrizione, evidenza del PoC, impatto, CVSS, remediation
4. Falsi negativi noti e limiti dello strumento (onestà = credibilità)
5. Allegato tecnico: log delle sessioni AI (audit trail), tool usati, tempi

## 9. Registro decisioni

Ogni gara produce una riga in questo registro (tenere in coda al file):

| Data | Gara | Vincitore | Decisione | Motivazione |
|---|---|---|---|---|
| (da compilare) | | | | |

## 10. Cadenza

- Bake-off slot cyber: alla Fase 4, poi **ogni volta che esce un modello
  rilevante** (Deep Hat V3, Qwen-3.6/4.x, ecc.) — il mercato si muove ogni
  trimestre.
- A/B collaborazione: al cambio di brain o di harness (CAI/maggiore).
- Regression test L0: ad ogni aggiornamento di llama.cpp **dopo** la
  validazione della build (scripts/validate-llamacpp-build.sh).
