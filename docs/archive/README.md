# Archivio — piani superati

Qui finiscono i **piani** (non i documenti di riferimento) il cui lavoro è atterrato su `master`:
restano consultabili come storia di come è stato deciso, ma fuori dalla superficie viva, così
`docs/` e la root tornano a dire cosa è vero adesso e non cosa si pensava di fare.

Criterio di archiviazione: **una prova di atterraggio**, cioè una voce di `CHANGELOG.md` o
l'artefatto che esiste nel repo. Non le checkbox del piano: misurato il 2026-09-28, il piano di
radar (`docs/superpowers/plans/2026-09-08-stavros-radar.md`) ha 26 checkbox aperte su 26 mentre i
tre tool `radar-*.js` sono atterrati da tempo — nessuno le spunta, quindi una spunta non è una prova.
Per lo stesso motivo un piano **non** archiviato non è implicitamente vivo: `piano-ottimizzazione-stavros.md`
resta fuori perché la sua Fase B (stop del vendoring dei binari) non è atterrata.

| file | archiviato il | perché | sostituto vivo |
|---|---|---|---|
| `command-center-redesign.md` | 2026-09-28 | redesign della dashboard: le fasi 1–6 sono atterrate (CHANGELOG 2026-09-08) | `tools/gui/`, `docs/toolbox.md` |
| `command-center-desktop-brief.md` | 2026-09-28 | brief per completare WP2–WP9: atterrati (CHANGELOG 2026-09-26) | `docs/command-center-desktop.md` |
| `command-center-pro-draft.html` | 2026-09-28 | bozza di design mai collegata al backend («DESIGN DRAFT — not wired to the backend»), superata dalla console atterrata (WP2–WP9) | `docs/command-center-desktop.md`, `tools/gui/` |

L'indice generato li elenca in [`docs/INDEX.md`](../INDEX.md), sezione **Archivio**.
