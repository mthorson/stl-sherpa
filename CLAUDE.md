# Portfolio Docs

`~/git/mthorson-repos/portfolio-docs/projects/stl-sherpa.md`

No `nodeIntegration` — renderer uses IPC via `contextBridge` only. SQLite (`better-sqlite3`) is main-process only, never import it in the renderer.
