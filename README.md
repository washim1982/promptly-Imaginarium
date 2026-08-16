# Imaginarium — Windows desktop

A native Windows build of the Imaginarium AI workspace. Same interface as the web
app, same inference: Google **Gemma 4 (E2B / E4B)** running entirely on your GPU
through **LiteRT-LM + WebGPU**. No inference server, no account, nothing leaves
the machine.

Ported from the browser build at `../workspace/Projects/Promptly`.

## Why Electron

LiteRT-LM has no CPU fallback — WebGPU is a hard requirement — and its wasm
runtime needs `SharedArrayBuffer`, which needs a cross-origin-isolated document.
Electron bundles its own Chromium, so both are guaranteed on every machine
regardless of what browser or Edge WebView runtime the user happens to have.

## What changed from the web build

The UI is a verbatim copy: every component, route, and the whole `index.css`
design system (ink background, the `--color-neon` accent variable, `glass` /
`neon-glow` utilities, mono micro-labels). Five things had to change:

| Area | Web build | Desktop build |
|---|---|---|
| **Model files** | 2 GB copied into OPFS before first use | Path remembered, file streamed off disk — nothing is copied |
| **Picking a model** | `<input type="file">` | Native Browse dialog, validated in the main process |
| **Cross-origin isolation** | COOP/COEP from nginx | `app://` protocol handler in `electron/main.ts` |
| **LiteRT-LM wasm** | fetched from jsDelivr at runtime | vendored into `public/litertlm/` |
| **Tesseract OCR** | worker + core from jsDelivr | vendored into `public/tesseract/` |

Also: `HashRouter` instead of `BrowserRouter`, the marketing landing page and the
Notebook/RAG placeholder routes dropped (the app opens straight into Chat), the
window's own header doubles as the title bar, and SEO/OG metadata is gone.

### Model handling, in detail

`electron/main.ts` keeps a small registry at
`%APPDATA%\Imaginarium\models.json` mapping each model id to a file path. When
you load a model, the renderer fetches `app://imaginarium/model/<id>`, the main
process answers with `fs.createReadStream`, and the resulting
`ReadableStream<Uint8Array>` goes straight into `Engine.create`. The bytes travel
disk → wasm heap without ever becoming a `Blob`.

Files you pick from your own disk are **never deleted** — "forget" only drops the
registry entry. Only models this app downloaded into `%APPDATA%\Imaginarium\models`
are removable from the UI.

## Requirements

- Windows 10/11 with a WebGPU-capable GPU (D3D12 or Vulkan) and current drivers
- Node 20+ to build
- A Gemma `.litertlm` file — see below

## Getting started

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` runs the Vite dev server (renderer HMR) plus esbuild in watch mode
for `electron/`, and launches Electron against it. Editing anything in `electron/`
rebuilds and restarts automatically.

```bash
npm run build
```

```bash
npm run dist
```

`npm run dist` produces an NSIS installer in `release/`.

## Getting the model

Gemma `.litertlm` files are gated and multi-GB, so they aren't bundled:

1. Accept the license at
   [litert-community/gemma-4-E2B-it-litert-lm](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
   (or the E4B repo).
2. Download `gemma-4-E2B-it-web.litertlm` (~2 GB) using the file's ↓ button on the
   "Files" tab — not the preview link.
3. In the app, **Browse for a .litertlm file…** and point at it. Leave it wherever
   you downloaded it; the app just remembers the path.

The in-app download button only works for non-gated repos.

## Web search (optional)

Research and the chat's Web toggle call `/api/search` and `/api/extract`, which
the main process forwards to a local **OrioSearch** instance (Tavily-compatible)
at `http://localhost:8005`. Override with the `ORIOSEARCH_URL` environment
variable. Without it running, search reports a clean error and the model answers
from its own knowledge.

## Layout

```
electron/       main.ts (app:// protocol, model registry + streaming, IPC)
                preload.ts (the renderer's entire native surface)
scripts/        dev.mjs · build-electron.mjs · vendor-assets.mjs
src/lib/        desktop (bridge) · modelStore (replaces the OPFS cache) ·
                engine · models · webgpu · pdf · search · history · themes · ui
src/state/      LlmContext.tsx — status, settings, chat, history, theme
src/components/ shell/ · chat/ · research/ · SettingsPanel
src/routes/     Research · PdfTools · About · Privacy
public/         litertlm/ + tesseract/ (vendored on postinstall)
```

## Icon

`build/icon.svg` is the source of truth. `npm run icon` rasterizes it into a
7-size `build/icon.ico` (16 → 256) plus a 256px PNG, using Electron's own
renderer — no ImageMagick or sharp needed. Each size is rasterized natively
rather than downscaled from 256px, and the accent spark is dropped below 32px
where it would collide with the star. `npm run dist` runs this automatically.

## Known gaps

- **The installer is unsigned**, so Windows SmartScreen will warn on first run.
- **The model slot is a label, not a check.** Picking an E4B file while the E2B
  slot is selected works — the engine reads the real file — and the loader now
  warns about the mismatch, but nothing stops you.

## License

Application code: MIT. Gemma models are subject to Google's
[Gemma Terms of Use](https://ai.google.dev/gemma/terms).
