# Imaginarium — Windows desktop

A native Windows build of the Imaginarium AI workspace. Same interface as the web
app, same inference: **any LiteRT-LM `.litertlm` model** running entirely on your
GPU through **LiteRT-LM + WebGPU**. No inference server, no account, nothing
leaves the machine.

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
| **Models** | Two hard-coded slots (E2B / E4B) | An open-ended library — add any `.litertlm` by browsing |
| **Model files** | 2 GB copied into OPFS before first use | Path remembered, file streamed off disk — nothing is copied |
| **Picking a model** | `<input type="file">` | Native Browse dialog, validated in the main process |
| **Cross-origin isolation** | COOP/COEP from nginx | `app://` protocol handler in `electron/main.ts` |
| **LiteRT-LM wasm** | fetched from jsDelivr at runtime | vendored into `public/litertlm/` |
| **Tesseract OCR** | worker + core from jsDelivr | vendored into `public/tesseract/` |

Also: `HashRouter` instead of `BrowserRouter`, the marketing landing page and the
Notebook/RAG placeholder routes dropped (the app opens straight into Chat), the
window's own header doubles as the title bar, and SEO/OG metadata is gone.

### The model library

There are no fixed model slots. `electron/main.ts` keeps a library at
`%APPDATA%\Imaginarium\models.json` — a list of entries, each with a generated
id, a renameable label (defaulting to the filename), and the file's path. **Add
Model** opens a native multi-select picker; every file is validated on its own,
so one bad pick doesn't discard the good ones, and adding a path that's already
in the library refreshes it rather than duplicating it.

Nothing constrains what you add beyond the format itself: an 8-byte `LITERTLM`
magic check and a minimum size, both done in the main process without reading
more than 8 bytes of a multi-GB file. A 12B model is as valid as a 2B one.

When you load a model, the renderer fetches `app://imaginarium/model/<id>`, the
main process answers with `fs.createReadStream`, and the resulting
`ReadableStream<Uint8Array>` goes straight into `Engine.create`. The bytes travel
disk → wasm heap without ever becoming a `Blob`.

Entries whose files have been moved or deleted are pruned automatically on every
listing. Files you picked from your own disk are **never deleted** — "remove"
only drops the library entry. Only models this app downloaded itself into
`%APPDATA%\Imaginarium\models` are deleted from disk, and the confirm dialog says
which case you're in.

The registry is versioned; a v1 file from the two-slot era is migrated to the
library format on first launch, so previously linked models carry over.

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

## Getting models

Any `.litertlm` file works. Models aren't bundled (they're multi-GB and mostly
gated), so:

1. Download a `.litertlm` — the
   [litert-community](https://huggingface.co/litert-community) org on Hugging
   Face publishes the web-optimized Gemma builds. Gated repos need you to accept
   the license while signed in; use the file's ↓ button on the "Files" tab, not
   the preview link.
2. In the app, **Browse for a .litertlm file…** (or **Add another model…**) and
   point at it. Leave it wherever you downloaded it — the app records the path,
   not a copy.

Add as many as you like and switch between them from the loader or ⚙ Settings.
The empty state also offers one-click downloads for the two Gemma builds, but
those only succeed for non-gated repos.

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
- **No per-model settings.** Temperature, max tokens, and the system prompt are
  global, so they don't follow the model you switch to.

## License

Application code: MIT. Gemma models are subject to Google's
[Gemma Terms of Use](https://ai.google.dev/gemma/terms).
