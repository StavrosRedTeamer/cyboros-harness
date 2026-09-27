# Rules of Engagement (RoE) e Lettera di Autorizzazione al Penetration Test

> **⚠️ AVVERTENZA — LEGGI PRIMA DI USARLO**
> Questo è un **template operativo**, non un parere legale. Prima di usarlo con clienti reali
> fallo **revisionare da un avvocato esperto di diritto informatico** e adattare alla tua forma
> giuridica (SRL / P.IVA) e alle tue coperture assicurative. I campi tra `«…»` vanno compilati.
> Le clausole marcate **[CRITICA]** sono quelle che ti proteggono penalmente: non rimuoverle.
>
> Documento da far firmare **PRIMA** di qualsiasi attività attiva sui sistemi del cliente.
> Un'autorizzazione retroattiva non ha valore.

---

## 1. Parti

**Fornitore (Tester):**
- Ragione sociale / Nome: «Ragione sociale del tester»
- P.IVA / C.F.: «…»
- Sede: «…»
- Referente tecnico: «Nome» — «email» — «telefono»

**Committente (Cliente):**
- Ragione sociale: «…»
- P.IVA / C.F.: «…»
- Sede: «…»
- Referente autorizzante: «Nome, ruolo»

**[CRITICA] Potere di firma.** Il Committente dichiara e garantisce che il firmatario del
presente documento è il **legale rappresentante** o soggetto munito di **idonei poteri/procura**
per autorizzare i test di sicurezza sui sistemi elencati nella Sezione 3. Il Fornitore è
sollevato da ogni responsabilità qualora tale potere non sussista.

---

## 2. Oggetto e finalità

Il Committente incarica il Fornitore di eseguire un'attività di **penetration testing / red teaming
autorizzato** sui sistemi definiti in Sezione 3 (l'«Ambito»), al solo scopo di **identificare
vulnerabilità di sicurezza** e fornirne evidenza in un report. L'attività è svolta in modalità
autorizzata e concordata; non costituisce accesso abusivo ai sensi dell'art. 615-ter c.p. in
quanto espressamente consentita dal titolare dei sistemi.

---

## 3. Ambito (Scope) — [CRITICA]

### 3.1 Asset AUTORIZZATI (in-scope)
Solo i seguenti asset sono oggetto di test. Tutto ciò che non è elencato è **fuori ambito**.

| Tipo | Identificativo | Note |
|---|---|---|
| Dominio | «target.com» | |
| Sottodominio | «api.target.com» | |
| Indirizzo IP / range | «203.0.113.10», «10.0.0.0/24» | |
| Applicazione / URL | «https://app.target.com» | |
| Rete / segmento | «VLAN «…»» | |
| Account di test forniti | «…» | vedi Allegato credenziali |

### 3.2 Asset ESCLUSI (out-of-scope)
Sono esplicitamente esclusi (elenco non esaustivo): «sistemi di produzione critici X»,
«infrastrutture di terzi non elencate», «qualsiasi asset non presente in 3.1».

### 3.3 [CRITICA] Titolarità degli asset e sistemi di terzi
Il Committente **dichiara e garantisce** di essere **titolare, oppure di avere pieno diritto e
autorità di autorizzare test** su **tutti** gli asset elencati in 3.1.

Per gli asset ospitati o gestiti da **terzi** (provider cloud — es. AWS/Azure/GCP —, hosting
condiviso, servizi SaaS, CDN, fornitori di rete), il Committente si impegna a **ottenere e
fornire** al Fornitore, **prima dell'inizio dei test**, ogni **autorizzazione o notifica**
richiesta dal terzo. Il Fornitore **non eseguirà test attivi** su asset di terzi finché tale
autorizzazione non sia documentata. Il Committente manleva il Fornitore da pretese di terzi
derivanti dalla mancata acquisizione di tali autorizzazioni.

---

## 4. Finestra temporale

- Inizio consentito: «gg/mm/aaaa hh:mm»
- Fine consentita: «gg/mm/aaaa hh:mm»
- Fasce orarie consentite: «es. 20:00–06:00 nei giorni feriali» / «H24»
- Nessuna attività attiva è consentita al di fuori di questa finestra.

---

## 5. Tecniche consentite e vietate

### 5.1 Consentite (barrare)
- [ ] Ricognizione passiva (OSINT, DNS, analisi superficie esposta)
- [ ] Scansione porte e servizi
- [ ] Vulnerability assessment (scanner automatici)
- [ ] Sfruttamento manuale di vulnerabilità (exploitation) con conferma
- [ ] Test applicativi web (OWASP: injection, XSS, authz, ecc.)
- [ ] Test di rete interna / movimento laterale (se in-scope)
- [ ] Password cracking offline su hash raccolti in-scope
- [ ] Social engineering verso dipendenti — **solo se espressamente barrato** → [ ]
- [ ] Test fisici / accesso a sedi — **solo se espressamente barrato** → [ ]
- [ ] Test su applicazioni/modelli LLM (prompt injection, jailbreak, data leakage)

### 5.2 [CRITICA] Vietate salvo consenso scritto separato
Salvo diversa e specifica autorizzazione scritta, sono **vietate**:
- attacchi **Denial of Service (DoS/DDoS)** o stress test volumetrici;
- **distruzione, cifratura o alterazione** di dati del Committente;
- **esfiltrazione** di dati reali oltre il minimo necessario a provare la vulnerabilità
  (proof-of-concept), con **immediata cancellazione** dopo la dimostrazione;
- azioni che compromettano la **continuità operativa** dei sistemi di produzione;
- test su qualsiasi asset **fuori ambito** (Sezione 3.2).

---

## 6. Regole operative (Rules of Engagement)

- **Rate limiting:** massimo «2» richieste/secondo verso i target, salvo diverso accordo.
- **Dati sensibili:** se il Fornitore incontra dati personali particolari (sanitari, finanziari,
  credenziali di terzi), **interrompe**, **non li copia** e li segnala al referente.
- **Vulnerabilità critica in corso / segni di compromissione preesistente:** il Fornitore
  **sospende** e avvisa **immediatamente** il referente del Committente.
- **Emergency stop:** al comando del referente («parola/segnale concordato»), il Fornitore
  **cessa ogni attività entro «…» minuti**.
- **Nessuna persistenza permanente:** eventuali impianti/agenti di test sono **rimossi** a fine
  ingaggio; ogni modifica all'ambiente è **documentata** e ripristinata.

### 6.1 Contatti di emergenza
| Ruolo | Nome | Telefono | Reperibilità |
|---|---|---|---|
| Referente Committente | «…» | «…» | «H24 durante finestra» |
| Referente tecnico Fornitore | «…» | «…» | «H24 durante finestra» |
| Escalation Committente (IT/sicurezza) | «…» | «…» | |

---

## 7. Gestione dati, riservatezza e GDPR — [CRITICA]

- Tutti i dati a cui il Fornitore accede durante l'attività sono **riservati** e trattati solo
  per le finalità del presente incarico.
- Ove il Fornitore tratti **dati personali** per conto del Committente, le parti sottoscrivono
  un **accordo sul trattamento (DPA)** ex art. 28 GDPR (Allegato «…»).
- **Infrastruttura di elaborazione:** il Fornitore dichiara che l'attività può avvalersi di
  **infrastruttura di calcolo** «locale / cloud presso «provider»» per l'elaborazione degli
  output. Il Committente ne prende atto e autorizza. *(Adatta questa riga in base a dove giri
  i modelli — locale o GPU affittata.)*
- **Egress dei dati del target:** salvo quanto sopra, gli output contenenti dati del Committente
  non sono divulgati a terzi non autorizzati.
- **Conservazione e cancellazione:** i dati raccolti sono conservati per «30» giorni ai fini del
  report, poi **cancellati in modo sicuro**, salvo obblighi di legge o diversa richiesta scritta.

---

## 8. Deliverable e findings

- Il Fornitore consegna un **report** contenente: sintesi esecutiva, vulnerabilità con severità,
  evidenze riproducibili (richiesta/risposta, comando, output) e raccomandazioni di remediation.
- Le vulnerabilità sono comunicate **solo** al Committente attraverso canali sicuri concordati.
- Il Fornitore **non divulga** pubblicamente né a terzi le vulnerabilità trovate senza consenso
  scritto del Committente.

---

## 9. Responsabilità e assicurazione — [CRITICA]

- Il Fornitore opera secondo la **diligenza professionale** del settore ma il penetration testing
  comporta **rischi intrinseci** (indisponibilità temporanea, comportamenti imprevisti dei
  sistemi testati). Il Committente ne è consapevole.
- Il Committente garantisce di aver eseguito **backup** aggiornati dei sistemi in-scope prima
  dell'inizio dei test.
- La responsabilità del Fornitore per danni diretti è **limitata a «… €» / al valore del
  contratto**, con esclusione dei danni indiretti, salvo dolo o colpa grave. *(Da calibrare con
  l'avvocato e con i massimali della tua polizza.)*
- Il Fornitore dichiara di essere coperto da **polizza RC professionale / cyber** n. «…»
  presso «…», massimale «…».
- Il Committente **manleva** il Fornitore per attività svolte **entro l'Ambito e le regole** del
  presente documento.

---

## 10. Legge applicabile e foro

Il presente accordo è regolato dalla **legge italiana**. L'autorizzazione qui contenuta rende
lecito l'accesso ai sistemi in-scope ai sensi degli artt. 615-ter e seguenti c.p. Per ogni
controversia è competente il foro di «città».

---

## 11. Firme — [CRITICA] da apporre PRIMA dell'inizio dei test

Le parti dichiarano di aver letto e compreso il presente documento in ogni sua parte.

**Per il Committente** (legale rappresentante / soggetto autorizzato con poteri):

Nome e ruolo: ______________________________

Firma: ______________________________  Data: ____________

Timbro aziendale: ______________________________

**Per il Fornitore:**

Nome: ______________________________

Firma: ______________________________  Data: ____________

---

### Allegati
- Allegato A — Elenco dettagliato asset in-scope e credenziali di test
- Allegato B — Autorizzazioni di terzi (provider cloud/hosting), se applicabili
- Allegato C — DPA ex art. 28 GDPR, se applicabile
- Allegato D — Piano di test / metodologia di riferimento (PTES / OWASP / OSSTMM)
