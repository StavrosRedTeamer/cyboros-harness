# Vendored terminal assets (zero-runtime-dep)

Static UMD builds used by the Freebuff terminal tab. No npm install required.

- `xterm.js`      — @xterm/xterm 6.0.0  (UMD, global: `Terminal`)
- `xterm.css`     — @xterm/xterm 6.0.0  stylesheet
- `addon-fit.js`  — @xterm/addon-fit 0.11.0 (UMD, global: `FitAddon`)

Refresh: `npm pack @xterm/xterm @xterm/addon-fit` then copy `lib/*.js` + `css/xterm.css` here.
