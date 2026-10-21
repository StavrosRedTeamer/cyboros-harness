/* Cyboros Console — interactive in-app guide (zero-dependency, token-driven).

   Self-contained: injects its own scoped styles, wires the topbar "Guida" button,
   builds a help overlay (searchable index + detailed content) lazily on first open,
   and offers a spotlight TOUR that highlights the real chrome. Reads the shared
   design tokens, so it looks right in BOTH themes (professional + cyberdeck). It
   never talks to the backend and adds no egress — pure client-side documentation.

   Kept out of app.js on purpose: it only touches its own button + its own overlay,
   so the load-bearing view code stays untouched. */
(function () {
  'use strict';

  function prefersReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  // ── content ────────────────────────────────────────────────────────────────
  // One card per view, grouped exactly as the tab bar groups them.
  var VIEWS = [
    ['Engagement', [
      ['overview', 'Overview', 'Il cruscotto d’ingaggio: KPI per severità, triage dei findings, hotspot per rischio, ultime finding, stato dell’ultimo run e report recenti. È il punto di partenza di ogni sessione.'],
      ['campaign', 'Campaign', 'Crea e attiva una campagna (cliente, RoE, finestra, obiettivi) da un template, àncora lo scope e archivia le campagne passate. La campagna attiva guida Mission e War Room.'],
      ['mission', 'Mission', 'Mission control deterministico: le prossime azioni arrivano dal planner dell’harness (non dall’LLM). Mostra cosa fare e perché, i gate ancora da superare e le approvazioni pendenti.'],
      ['warroom', 'War Room', 'La board live dell’operazione: KPI della campagna, pannello Attention, feed del ledger in tempo reale, budget, coverage ed exposure. La modalità TV la rende leggibile da un secondo monitor o dal telefono via tunnel F3.'],
      ['approvals', 'Approvals', 'L’inbox delle approvazioni: l’agente chiede, l’operatore concede o nega. Il consenso diventa un token verificabile (azioni confirm-tier) invece di una semplice frase in chat.'],
      ['ledger', 'Ledger', 'La timeline dell’engagement, il verdetto della hash-chain dei findings e la generazione dell’evidence bundle firmato (findings + artifact-ledger + gate-log + approvazioni) da consegnare al cliente.'],
    ]],
    ['Attack', [
      ['findings', 'Findings', 'Il registro dei findings, filtrabile e ordinabile: severità, CVSS, CWE, livello di verifica e stato. Un click su una riga apre il pannello di dettaglio con host, endpoint e PoC.'],
      ['pipeline', 'Pipeline', 'Il DAG delle fasi dell’ultimo run (recon → map → test → …) con lo stato di ciascuna fase. Si popola dopo aver lanciato una ricognizione dall’harness.'],
      ['sessions', 'Sessions', 'Le sessioni attive e gli artefatti di teardown. È in sola lettura: il cleanup è un’azione confirm-tier che si esegue da CLI.'],
      ['graph', 'Graph', 'La topologia host → servizi aperti → finding, più la host exposure map (porte, servizi e rischio per host). Clicca un nodo per i dettagli o un finding per accendere il percorso.'],
      ['coverage', 'Coverage', 'La copertura MITRE ATT&CK e i gap residui per classe e per host: cosa è stato testato e cosa manca ancora.'],
    ]],
    ['Control', [
      ['scope', 'Scope', 'L’editor di scope.json: host, prefissi URL e IP/CIDR autorizzati più il pacing (req/s). Ogni salvataggio è validato lato server e non bypassa mai il guard. Include la verifica live di un URL.'],
      ['arsenal', 'Arsenal', 'Il registro degli strumenti (presente/mancante), lo stato di runtime e vendor, il doctor e il tool-plane. Da qui installi i tool mancanti.'],
      ['control', 'Control', 'La configurazione (con i segreti redatti), il fleet plan, il doctor, la knowledge base e il radar — che dichiara la propria uscita di rete con un badge egress.'],
      ['users', 'Users', 'Account e ruoli (viewer · operator · admin): chi può leggere, agire o gestire gli account. Visibile solo con ruolo admin.'],
    ]],
    ['Console', [
      ['chat', 'Chat', 'Conversazione con il modello locale: solo chat, nessun tool e nessuna azione di scope. Un badge indica se l’endpoint è locale o cloud.'],
      ['reports', 'Reports', 'Genera il report HTML standalone (findings + state.db + attack chains) e lo visualizza. È il deliverable che riceve il cliente.'],
      ['freebuff', 'Freebuff', 'Un terminale interattivo live (pseudo-terminale) verso lo strumento Freebuff: la sessione vive lato server e sopravvive ai reload del browser.'],
    ]],
  ];

  var CONCEPTS = [
    ['Scope & guard — l’autorizzazione', 'scope.json è l’autorizzazione scritta ed è <b>fail-closed</b>: se è vuoto o l’host non c’è, tutto è bloccato. I guard (scope, c2, wifi, mobile, ssrf) girano in processi separati <i>sotto</i> l’agente e decidono l’autorizzazione prima che il modello legga la richiesta. Non si bypassa: se serve, si allarga lo scope con l’autorizzazione corrispondente.'],
    ['Approvazioni — human-in-the-loop', 'Le azioni intrusive o confirm-tier (sqlmap, netexec, coercion, brute force, C2…) richiedono il consenso esplicito dell’operatore, una alla volta. L’app non esegue mai l’azione: la <i>consente</i> emettendo un token verificabile, poi l’agente la esegue con <code>--confirm</code>.'],
    ['Ledger & evidence bundle', 'Ogni passo finisce in un audit-trail con hash-chain. L’evidence bundle raccoglie findings, artifact-ledger, gate-log e approvazioni in un pacchetto verificabile: è la prova consegnabile che l’engagement è stato condotto nei limiti autorizzati.'],
    ['Findings — riproducibilità', 'Ogni finding deve essere riproducibile: richiesta/risposta, comando e output. Il <i>verify level</i> (proven · confirmed · weak) dice quanto è solida la prova, non solo che esiste.'],
    ['Opsec — zero egress', 'Nessun dato esce: target, credenziali e output restano locali. L’app parla solo con 127.0.0.1 (loopback + token di sessione per ogni scrittura), i pannelli che escono davvero lo dichiarano con un badge egress, e i dati cliente stanno fuori da git.'],
    ['Mission control deterministico', 'Le prossime azioni vengono dal planner dell’harness, non da un LLM. La stessa logica alimenta Mission e la CLI: numeri e priorità coincidono, così la board non “allucina” un piano.'],
  ];

  var SHORTCUTS = [
    ['⌘K', 'Ctrl / ⌘ + K', 'Apre la command palette: salta a una vista o esegui un’azione.'],
    ['↑ ↓ ↵', 'Frecce + Invio', 'Nella palette: naviga le voci ed esegui quella selezionata.'],
    ['Esc', 'Esc', 'Chiude la palette, un modale, il drawer di dettaglio o questa guida.'],
    ['?', '? oppure F1', 'Apre questa guida interattiva.'],
    ['⛶', '⛶ / F11', 'Nel terminale Freebuff: schermo intero (Esc per uscire).'],
    ['◐', 'pulsante tema', 'Alterna il tema professionale ⇄ cyberdeck.'],
  ];

  var TOUR = [
    ['.brand', 'Command Center', 'Questa è la console operatore di Cyboros Harness: governa un engagement autorizzato da campagna a report. Partiamo da un giro veloce.'],
    ['#tabs', 'Le sezioni', 'Le viste sono raggruppate in quattro famiglie: <b>Engagement</b> (campagna, missione, approvazioni), <b>Attack</b> (findings, pipeline, grafo), <b>Control</b> (scope, arsenale) e <b>Console</b> (chat, report, terminale).'],
    ['#status-rail', 'Telemetria live', 'La striscia di stato è sempre visibile: scope, rate limit, run in corso, sessioni, findings e loot. Ogni voce ha un pip colorato (ok · warn · bad · live).'],
    ['#btn-cmdk', 'Command palette', 'Premi ⌘K (o Ctrl-K) per saltare a qualsiasi vista o lanciare un’azione senza cercare col mouse. È il modo più rapido di muoversi.'],
    ['#view', 'L’area di lavoro', 'Qui vive la vista attiva. Ora stai guardando l’Overview: KPI di severità, triage e hotspot. Cambia sezione dalla barra in alto.', 'overview'],
    ['#btn-theme', 'Tema', 'Alterna tra il tema <b>professionale</b> (enterprise, calmo) e il <b>cyberdeck</b> (HUD neon). La scelta viene ricordata.'],
    ['#btn-guide', 'Questa guida', 'Riapri questa guida quando vuoi da qui, oppure premi <b>?</b>. Buon lavoro.'],
  ];

  // ── styles ─────────────────────────────────────────────────────────────────
  var CSS = [
    '.guide-ov{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;',
    'background:rgba(4,6,12,.62);backdrop-filter:blur(3px);padding:24px;font-family:var(--sans,system-ui)}',
    '.guide-ov.hidden{display:none}',
    '.guide-modal{width:min(1120px,96vw);height:min(840px,92vh);display:flex;flex-direction:column;',
    'background:var(--surface,#151b24);border:1px solid var(--line-2,#323b49);border-radius:12px;overflow:hidden;',
    'box-shadow:0 30px 90px rgba(0,0,0,.6)}',
    '.guide-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line,#242c38);background:var(--surface-2,#1b222d)}',
    '.guide-head .gh-logo{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;border:1px solid var(--line-2,#323b49);color:var(--accent,#4f8cff);font-size:15px;background:var(--surface,#151b24)}',
    '.guide-head h2{margin:0;font:600 15px/1.2 var(--sans,system-ui);color:var(--ink,#e6e9ef)}',
    '.guide-head .gh-sub{font:12px var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-x{margin-left:auto;background:transparent;border:1px solid var(--line-2,#323b49);color:var(--muted,#9aa4b2);',
    'width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:15px;line-height:1}',
    '.guide-x:hover{color:var(--ink,#e6e9ef);border-color:var(--accent,#4f8cff)}',
    '.guide-body{flex:1;display:flex;min-height:0}',
    '.guide-side{flex:0 0 232px;border-right:1px solid var(--line,#242c38);background:var(--bg2,#090c12);display:flex;flex-direction:column;min-height:0}',
    '.guide-search{margin:12px;padding:8px 11px;background:var(--surface,#151b24);border:1px solid var(--line-2,#323b49);',
    'border-radius:7px;color:var(--ink,#e6e9ef);font:13px var(--sans,system-ui);outline:none}',
    '.guide-search:focus{border-color:var(--accent,#4f8cff);box-shadow:0 0 0 2px rgba(79,140,255,.3)}',
    '.guide-toc{list-style:none;margin:0;padding:0 8px 12px;overflow-y:auto}',
    '.guide-toc li{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:7px;cursor:pointer;',
    'font:500 13px var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-toc li .gt-ico{width:18px;text-align:center;color:var(--faint,#68717f)}',
    '.guide-toc li:hover{background:var(--hover-bg,rgba(79,140,255,.07));color:var(--ink,#e6e9ef)}',
    '.guide-toc li.active{background:var(--active-bg,rgba(79,140,255,.13));color:var(--ink,#e6e9ef)}',
    '.guide-toc li.active .gt-ico{color:var(--accent,#4f8cff)}',
    '.guide-main{flex:1;overflow-y:auto;padding:4px 30px 48px;min-width:0}',
    '.guide-sec{padding-top:26px}',
    '.guide-sec>h3{font:600 18px/1.3 var(--sans,system-ui);color:var(--ink,#e6e9ef);margin:0 0 6px}',
    '.guide-sec p{font:14px/1.65 var(--sans,system-ui);color:var(--muted,#9aa4b2);max-width:72ch;margin:0 0 12px}',
    '.guide-sec p b{color:var(--ink,#e6e9ef);font-weight:600}',
    '.guide-sec code{font-family:var(--mono,ui-monospace);font-size:12.5px;color:var(--accent,#4f8cff);',
    'background:var(--bg2,#090c12);border:1px solid var(--line,#242c38);border-radius:4px;padding:1px 5px}',
    '.guide-hero{display:flex;gap:20px;align-items:flex-start;background:linear-gradient(140deg,rgba(79,140,255,.1),transparent 60%),var(--surface-2,#1b222d);',
    'border:1px solid var(--line-2,#323b49);border-radius:10px;padding:18px 20px;margin-top:20px}',
    '.guide-hero .gh-k{font-size:30px;color:var(--accent,#4f8cff);line-height:1}',
    '.guide-hero h3{margin:0 0 6px}',
    '.guide-cta{display:inline-flex;align-items:center;gap:8px;margin-top:4px;background:var(--accent,#4f8cff);color:#0b1017;',
    'border:0;border-radius:7px;padding:9px 16px;font:600 13px var(--sans,system-ui);cursor:pointer}',
    '.guide-cta:hover{filter:brightness(1.08)}',
    '.guide-steps{list-style:none;counter-reset:gs;margin:8px 0 0;padding:0;display:grid;gap:8px}',
    '.guide-steps li{counter-increment:gs;position:relative;padding:8px 10px 8px 40px;border:1px solid var(--line,#242c38);',
    'border-radius:8px;background:var(--bg2,#090c12);font:13.5px/1.5 var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-steps li b{color:var(--ink,#e6e9ef)}',
    '.guide-steps li::before{content:counter(gs);position:absolute;left:10px;top:8px;width:20px;height:20px;border-radius:50%;',
    'display:grid;place-items:center;background:var(--accent-dim,#1d3a66);color:var(--accent,#4f8cff);font:600 11px var(--mono,ui-monospace)}',
    '.guide-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));margin-top:6px}',
    '.guide-group-h{font:600 11px var(--sans,system-ui);text-transform:uppercase;letter-spacing:.12em;color:var(--faint,#68717f);',
    'margin:16px 0 2px;grid-column:1/-1}',
    '.guide-card{border:1px solid var(--line,#242c38);border-left:3px solid var(--accent,#4f8cff);border-radius:8px;',
    'padding:11px 13px;background:var(--bg2,#090c12)}',
    '.guide-card h4{margin:0 0 4px;font:600 13.5px var(--sans,system-ui);color:var(--ink,#e6e9ef)}',
    '.guide-card p{font:12.5px/1.55 var(--sans,system-ui);color:var(--muted,#9aa4b2);margin:0;max-width:none}',
    '.guide-kv{display:grid;gap:8px;margin-top:6px}',
    '.guide-kv .gk{display:flex;gap:12px;align-items:baseline;border:1px solid var(--line,#242c38);border-radius:8px;padding:9px 12px;background:var(--bg2,#090c12)}',
    '.guide-kv .gk-k{flex:0 0 150px;font:600 13px var(--sans,system-ui);color:var(--ink,#e6e9ef)}',
    '.guide-kv .gk-v{font:13px/1.5 var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-key{display:grid;gap:7px;margin-top:6px}',
    '.guide-key .gky{display:grid;grid-template-columns:70px 150px 1fr;gap:12px;align-items:center;padding:7px 2px;border-bottom:1px solid var(--line,#242c38)}',
    '.guide-key kbd{justify-self:start;font:600 12px var(--mono,ui-monospace);background:var(--surface-2,#1b222d);border:1px solid var(--line-2,#323b49);',
    'border-bottom-width:2px;border-radius:5px;padding:2px 8px;color:var(--ink,#e6e9ef)}',
    '.guide-key .gky-n{font:12.5px var(--sans,system-ui);color:var(--faint,#68717f)}',
    '.guide-key .gky-d{font:13px/1.5 var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-empty{padding:40px 0;color:var(--faint,#68717f);font:14px var(--sans,system-ui);text-align:center}',
    // tour
    '.guide-tour{position:fixed;inset:0;z-index:140}',
    '.guide-tour-block{position:absolute;inset:0}',
    '.guide-spot{position:absolute;border-radius:9px;box-shadow:0 0 0 9999px rgba(4,6,12,.68);',
    'outline:2px solid var(--accent,#4f8cff);outline-offset:3px;transition:all .22s ease;pointer-events:none}',
    '.guide-tip{position:absolute;width:min(330px,88vw);background:var(--surface,#151b24);border:1px solid var(--accent,#4f8cff);',
    'border-radius:10px;padding:14px 16px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.guide-tip h4{margin:0 0 6px;font:600 14px var(--sans,system-ui);color:var(--ink,#e6e9ef)}',
    '.guide-tip p{margin:0 0 12px;font:13px/1.6 var(--sans,system-ui);color:var(--muted,#9aa4b2)}',
    '.guide-tip p b{color:var(--ink,#e6e9ef)}',
    '.guide-tip code{font-family:var(--mono,ui-monospace);font-size:12px;color:var(--accent,#4f8cff)}',
    '.guide-tip-foot{display:flex;align-items:center;gap:8px}',
    '.guide-tip-foot .gt-count{font:12px var(--mono,ui-monospace);color:var(--faint,#68717f);margin-right:auto}',
    '.guide-tip button{border-radius:6px;padding:6px 12px;font:600 12.5px var(--sans,system-ui);cursor:pointer;border:1px solid var(--line-2,#323b49);background:transparent;color:var(--muted,#9aa4b2)}',
    '.guide-tip button:hover{color:var(--ink,#e6e9ef);border-color:var(--accent,#4f8cff)}',
    '.guide-tip button.gt-primary{background:var(--accent,#4f8cff);border-color:var(--accent,#4f8cff);color:#0b1017}',
    '@media (prefers-reduced-motion:reduce){.guide-spot{transition:none}}',
  ].join('');

  function injectStyles() {
    if (document.getElementById('guide-css')) return;
    var s = document.createElement('style');
    s.id = 'guide-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  var SECTIONS = [
    { id: 'welcome', ico: '◈', label: 'Benvenuto', render: renderWelcome },
    { id: 'workflow', ico: '↳', label: 'Il flusso di lavoro', render: renderWorkflow },
    { id: 'nav', ico: '▤', label: 'Navigazione', render: renderNav },
    { id: 'views', ico: '◳', label: 'Le viste', render: renderViews },
    { id: 'concepts', ico: '❖', label: 'Concetti Cyboros', render: renderConcepts },
    { id: 'shortcuts', ico: '⌘', label: 'Scorciatoie', render: renderShortcuts },
    { id: 'security', ico: '⛨', label: 'Sicurezza & opsec', render: renderSecurity },
  ];

  function renderWelcome() {
    return '<div class="guide-hero"><div class="gh-k">◈</div><div>' +
      '<h3>Cyboros Harness — Command Center</h3>' +
      '<p>La console che governa un pentest <b>autorizzato</b> a 360°: campagna → missione → consenso → esecuzione → verifica → report → prova. Il principio di fondo: <b>la policy sta nel runtime, non nel prompt</b> — i guard decidono l’autorizzazione prima del modello, e sono fail-closed.</p>' +
      '<button class="guide-cta" data-guide="tour">▶ Avvia tour guidato</button></div></div>' +
      '<p style="margin-top:18px">Nuovo qui? Il percorso tipico in cinque passi:</p>' +
      '<ol class="guide-steps">' +
      '<li><b>Definisci lo scope</b> nella vista <b>Scope</b> — è l’autorizzazione scritta, senza di essa tutto è bloccato.</li>' +
      '<li><b>Attiva una campagna</b> in <b>Campaign</b> (cliente, RoE, obiettivi).</li>' +
      '<li><b>Segui Mission</b>: ti dice la prossima azione e perché, in modo deterministico.</li>' +
      '<li><b>Concedi le approvazioni</b> richieste dall’agente per le azioni intrusive.</li>' +
      '<li><b>Rivedi i Findings</b> e genera il <b>Report</b> / l’<b>evidence bundle</b> per il cliente.</li>' +
      '</ol>';
  }

  function renderWorkflow() {
    var kv = [
      ['1 · Scope', 'scope.json autorizza host/IP/prefissi e il pacing. Fail-closed: vuoto ⇒ tutto bloccato.'],
      ['2 · Campaign', 'La campagna lega cliente, RoE, finestra e obiettivi, e àncora l’hash dello scope.'],
      ['3 · Mission', 'Il planner dell’harness calcola le prossime azioni e i gate mancanti — non l’LLM.'],
      ['4 · Approvals', 'Le azioni confirm-tier passano dal consenso dell’operatore, che diventa un token verificabile.'],
      ['5 · Esecuzione', 'I tool girano gated (run.js / workflow.js): scope + enforce + gating, mai i binari nudi.'],
      ['6 · Findings', 'Ogni risultato è riproducibile e ha un verify level; confluisce in Findings, Graph e Coverage.'],
      ['7 · Gate & Report', 'I gate di fase sbloccano il report; si genera l’HTML standalone per il cliente.'],
      ['8 · Evidence', 'L’evidence bundle (hash-chain) racchiude findings, artefatti, gate e approvazioni: prova verificabile.'],
    ];
    return '<p>Cyboros tratta un engagement come una catena verificabile. Ogni anello è una vista della console:</p>' +
      '<div class="guide-kv">' + kv.map(function (r) {
        return '<div class="gk"><div class="gk-k">' + r[0] + '</div><div class="gk-v">' + r[1] + '</div></div>';
      }).join('') + '</div>';
  }

  function renderNav() {
    return '<p>La chrome resta sempre a portata, su ogni vista:</p>' +
      '<div class="guide-kv">' +
      '<div class="gk"><div class="gk-k">Barra in alto</div><div class="gk-v">Brand, pulsante <b>Guida</b>, tema <b>pro ⇄ cyberdeck</b>, command palette (⌘K) e refresh.</div></div>' +
      '<div class="gk"><div class="gk-k">Tab, 4 gruppi</div><div class="gk-v"><b>Engagement</b> · <b>Attack</b> · <b>Control</b> · <b>Console</b>. Le etichette grigie separano i gruppi.</div></div>' +
      '<div class="gk"><div class="gk-k">Status rail</div><div class="gk-v">Telemetria live sotto le tab: scope, req/s, run, sessioni, findings, loot — con pip ok/warn/bad/live.</div></div>' +
      '<div class="gk"><div class="gk-k">Command palette</div><div class="gk-v">⌘K / Ctrl-K: salta a una vista o lancia un’azione, da tastiera.</div></div>' +
      '<div class="gk"><div class="gk-k">Toast & drawer</div><div class="gk-v">Le azioni mostrano un toast in basso a destra; i dettagli si aprono in un drawer laterale.</div></div>' +
      '</div>';
  }

  function renderViews() {
    return '<p>Diciotto viste, raggruppate come nella barra. Clicca una tab per aprirla; qui trovi cosa mostra e a cosa serve.</p>' +
      '<div class="guide-grid">' + VIEWS.map(function (grp) {
        return '<div class="guide-group-h">' + grp[0] + '</div>' + grp[1].map(function (v) {
          return '<div class="guide-card" data-tab="' + v[0] + '"><h4>' + v[1] + '</h4><p>' + v[2] + '</p></div>';
        }).join('');
      }).join('') + '</div>';
  }

  function renderConcepts() {
    return '<p>I concetti che rendono Cyboros diverso da “un LLM con dei tool”:</p>' +
      '<div class="guide-kv">' + CONCEPTS.map(function (c) {
        return '<div class="gk"><div class="gk-k">' + c[0] + '</div><div class="gk-v">' + c[1] + '</div></div>';
      }).join('') + '</div>';
  }

  function renderShortcuts() {
    return '<p>Scorciatoie da tastiera:</p><div class="guide-key">' +
      SHORTCUTS.map(function (s) {
        return '<div class="gky"><kbd>' + s[0] + '</kbd><span class="gky-n">' + s[1] + '</span><span class="gky-d">' + s[2] + '</span></div>';
      }).join('') + '</div>';
  }

  function renderSecurity() {
    return '<p>La console è progettata attorno all’opsec dell’operatore:</p>' +
      '<div class="guide-kv">' +
      '<div class="gk"><div class="gk-k">Zero egress</div><div class="gk-v">Target, credenziali e output non escono. L’app parla solo con 127.0.0.1; i pannelli che escono (es. radar → GitHub) lo dichiarano con un badge egress.</div></div>' +
      '<div class="gk"><div class="gk-k">Loopback + token</div><div class="gk-v">Ogni scrittura richiede il token di sessione; Host/Origin sono verificati (anti DNS-rebinding/CSRF).</div></div>' +
      '<div class="gk"><div class="gk-k">Sola lettura</div><div class="gk-v">In modalità read-only l’app ispeziona senza scrivere: nessuna azione, solo visione.</div></div>' +
      '<div class="gk"><div class="gk-k">Dati cliente</div><div class="gk-v">scope, campagne, approvazioni e report restano fuori da git.</div></div>' +
      '<div class="gk"><div class="gk-k">Guard fail-closed</div><div class="gk-v">Se un guard non carica (scope illeggibile) l’app mostra <b>bloccato</b>, mai “consentito”.</div></div>' +
      '</div>';
  }

  // ── overlay ────────────────────────────────────────────────────────────────
  var ov = null, lastFocus = null;

  function build() {
    if (ov) return;
    injectStyles();
    ov = document.createElement('div');
    ov.className = 'guide-ov hidden';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Guida interattiva');
    ov.setAttribute('aria-labelledby', 'guide-title');

    var toc = SECTIONS.map(function (s, i) {
      return '<li data-sec="' + s.id + '"' + (i === 0 ? ' class="active"' : '') +
        '><span class="gt-ico">' + s.ico + '</span>' + s.label + '</li>';
    }).join('');
    var content = SECTIONS.map(function (s) {
      return '<section class="guide-sec" id="guide-sec-' + s.id + '"><h3>' + s.label + '</h3>' + s.render() + '</section>';
    }).join('');

    ov.innerHTML =
      '<div class="guide-modal">' +
      '<div class="guide-head"><span class="gh-logo">◈</span>' +
      '<div><h2 id="guide-title">Guida · Cyboros Command Center</h2><div class="gh-sub">Come usare la console e l’harness</div></div>' +
      '<button class="guide-x" data-guide="close" aria-label="Chiudi guida">✕</button></div>' +
      '<div class="guide-body">' +
      '<div class="guide-side"><input class="guide-search" type="search" placeholder="Cerca nella guida…" aria-label="Cerca nella guida">' +
      '<ul class="guide-toc">' + toc + '</ul></div>' +
      '<div class="guide-main">' + content + '</div>' +
      '</div></div>';
    document.body.appendChild(ov);

    var main = ov.querySelector('.guide-main');
    var tocEl = ov.querySelector('.guide-toc');

    // click handling (close, tour, section nav, tab jump)
    ov.addEventListener('click', function (e) {
      var act = e.target.closest('[data-guide]');
      if (act) {
        var a = act.getAttribute('data-guide');
        if (a === 'close') return close();
        if (a === 'tour') { close(); startTour(); return; }
      }
      var li = e.target.closest('.guide-toc li');
      if (li) { scrollToSec(li.getAttribute('data-sec')); return; }
      var card = e.target.closest('.guide-card[data-tab]');
      if (card) { var b = document.getElementById('tabbtn-' + card.getAttribute('data-tab')); if (b) { b.click(); close(); } }
    });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    // focus trap: keep Tab / Shift+Tab inside the dialog while it is open
    ov.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var modal = ov.querySelector('.guide-modal');
      var f = [].slice.call(modal.querySelectorAll(
        'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'
      )).filter(function (el) { return el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // scroll-spy: highlight the TOC entry of the section in view
    main.addEventListener('scroll', function () {
      var secs = main.querySelectorAll('.guide-sec');
      var top = main.scrollTop, cur = SECTIONS[0].id;
      secs.forEach(function (sec) { if (sec.offsetTop - 80 <= top) cur = sec.id.replace('guide-sec-', ''); });
      setActive(cur);
    });

    function setActive(id) {
      tocEl.querySelectorAll('li').forEach(function (li) {
        li.classList.toggle('active', li.getAttribute('data-sec') === id);
      });
    }
    function scrollToSec(id) {
      var sec = document.getElementById('guide-sec-' + id);
      if (sec) main.scrollTo({ top: sec.offsetTop - 12, behavior: prefersReduced() ? 'auto' : 'smooth' });
      setActive(id);
    }
    ov._scrollToSec = scrollToSec;

    // search filter
    var search = ov.querySelector('.guide-search');
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      var anyShown = false;
      main.querySelectorAll('.guide-sec').forEach(function (sec) {
        var secHit = !q || sec.textContent.toLowerCase().indexOf(q) >= 0;
        // within "views", filter cards individually
        var cards = sec.querySelectorAll('.guide-card');
        if (cards.length && q) {
          var localHit = false;
          cards.forEach(function (c) {
            var m = c.textContent.toLowerCase().indexOf(q) >= 0;
            c.style.display = m ? '' : 'none';
            if (m) localHit = true;
          });
          secHit = localHit || sec.querySelector('h3').textContent.toLowerCase().indexOf(q) >= 0;
          if (!localHit) cards.forEach(function (c) { c.style.display = secHit ? '' : 'none'; });
        } else {
          cards.forEach(function (c) { c.style.display = ''; });
        }
        sec.style.display = secHit ? '' : 'none';
        if (secHit) anyShown = true;
        var gh = sec.querySelectorAll('.guide-group-h');
        gh.forEach(function (g) { g.style.display = ''; });
      });
      var empty = ov.querySelector('.guide-empty');
      if (!anyShown && !empty) {
        empty = document.createElement('div');
        empty.className = 'guide-empty';
        empty.textContent = 'Nessun risultato per “' + search.value + '”.';
        main.appendChild(empty);
      } else if (empty) { empty.style.display = anyShown ? 'none' : ''; }
    });
  }

  function open() {
    build();
    lastFocus = document.activeElement;
    ov.classList.remove('hidden');
    var s = ov.querySelector('.guide-search');
    setTimeout(function () { if (s) s.focus(); }, 20);
  }
  function close() {
    if (ov) ov.classList.add('hidden');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function isOpen() { return ov && !ov.classList.contains('hidden'); }

  // ── spotlight tour ──────────────────────────────────────────────────────────
  var tourEl = null, tourIdx = 0;

  function startTour() {
    injectStyles();
    tourIdx = 0;
    tourEl = document.createElement('div');
    tourEl.className = 'guide-tour';
    tourEl.innerHTML = '<div class="guide-tour-block"></div><div class="guide-spot"></div>' +
      '<div class="guide-tip"><h4></h4><p></p><div class="guide-tip-foot">' +
      '<span class="gt-count"></span>' +
      '<button data-t="skip">Salta</button><button data-t="prev">Indietro</button>' +
      '<button class="gt-primary" data-t="next">Avanti</button></div></div>';
    document.body.appendChild(tourEl);
    tourEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-t]'); if (!b) return;
      var t = b.getAttribute('data-t');
      if (t === 'skip') return endTour();
      if (t === 'prev') return step(tourIdx - 1);
      if (t === 'next') return (tourIdx >= TOUR.length - 1) ? endTour() : step(tourIdx + 1);
    });
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    step(0);
  }

  function step(i) {
    if (i < 0 || i >= TOUR.length) return;
    tourIdx = i;
    var s = TOUR[i];
    if (s[3]) { var tb = document.getElementById('tabbtn-' + s[3]); if (tb) tb.click(); }
    var tip = tourEl.querySelector('.guide-tip');
    tip.querySelector('h4').textContent = s[1];
    tip.querySelector('p').innerHTML = s[2];
    tip.querySelector('.gt-count').textContent = (i + 1) + ' / ' + TOUR.length;
    tourEl.querySelector('[data-t="prev"]').style.visibility = i === 0 ? 'hidden' : '';
    tourEl.querySelector('[data-t="next"]').textContent = i === TOUR.length - 1 ? 'Fine' : 'Avanti';
    var target = document.querySelector(s[0]);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: prefersReduced() ? 'auto' : 'smooth' });
    requestAnimationFrame(function () { requestAnimationFrame(reposition); });
  }

  function reposition() {
    if (!tourEl) return;
    var s = TOUR[tourIdx];
    var target = document.querySelector(s[0]);
    var spot = tourEl.querySelector('.guide-spot');
    var tip = tourEl.querySelector('.guide-tip');
    if (!target) { spot.style.display = 'none'; return; }
    spot.style.display = '';
    var r = target.getBoundingClientRect();
    var pad = 6;
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    var tw = tip.offsetWidth, th = tip.offsetHeight, gap = 16;
    var vw = window.innerWidth, vh = window.innerHeight;
    var top = r.bottom + gap;
    if (top + th > vh - 8) top = r.top - th - gap;          // flip above
    if (top < 8) top = Math.min(vh - th - 8, Math.max(8, (vh - th) / 2));
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(10, Math.min(left, vw - tw - 10));
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  function endTour() {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    if (tourEl) { tourEl.remove(); tourEl = null; }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  function init() {
    var btn = document.getElementById('btn-guide');
    if (btn) btn.addEventListener('click', open);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (tourEl) return endTour(); if (isOpen()) return close(); }
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === '?' || e.key === 'F1') && !isOpen() && !tourEl) { e.preventDefault(); open(); }
    });
    // First launch only: open the guide once, then remember it (per browser).
    try {
      if (!localStorage.getItem('cyboros-guide-seen')) {
        localStorage.setItem('cyboros-guide-seen', '1');
        setTimeout(open, 450);
      }
    } catch (e) { /* storage blocked (private window) — just skip the auto-open */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
