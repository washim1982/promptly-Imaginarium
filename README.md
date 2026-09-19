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

## SVN Studio tab

A port of SVN Studio (`../research/UI_SVN`, its React web client) as a tab next
to PDF Tools: Explorer tree, Monaco editor with diff view, Source Control
(commit / update / revert), History with lock/unlock, command palette (Ctrl+K),
resizable panels, and AI review.

- **No server.** SVN Studio's Express API is gone; `electron/svn/` runs the same
  `svn` commands in the main process over IPC (`svn:*` channels), with every path
  checked against the working-copy root.
- **svn.exe is found automatically** — PATH, then VisualSVN Server, TortoiseSVN,
  SlikSVN and CollabNet install folders — or set it in SVN Settings.
- **AI review runs on gemma-4-E4B-it-web** in the app's own engine, not an
  external OpenAI-compatible endpoint. If another model is loaded, the review
  switches the engine to E4B (so Chat uses E4B afterwards, too). The context
  budget is derived from the Context window / Max reply tokens settings.
- **Password** is stored with Electron `safeStorage` (Windows DPAPI), in
  `%APPDATA%\Imaginarium\svn-settings.json`.
- **Theme:** the tab's palette resolves to the app's tokens (glass panels, ink,
  `--color-neon`), so it follows the accent chosen in Settings. Styles are scoped
  under `.svn-studio` with `--svn-*` tokens to avoid Tailwind's `--radius-*` /
  `--font-*` theme variables.

### Behaviour that differs from SVN Studio (bug fixes)

| SVN Studio | Here |
|---|---|
| Editor loaded files with `svn cat` — the BASE revision — so a modified file showed stale content and saving could overwrite uncommitted work | Reads the working file; `svn cat` only for files missing from disk |
| Explorer came from `svn list` (repository at the WC root's BASE): files you just committed disappeared until Update | Explorer is the working copy on disk, overlaid with `svn status` |
| History from `svn log <wc>` (BASE): your own commits didn't show until Update | `svn log -r HEAD:1` |
| `svn status` has no `kind`, so new folders showed as a file plus a duplicate folder | Kind from disk / `svn info` |
| Property-only changes (e.g. `svn:ignore`) were invisible | Shown as modified; the WC root gets its own row |
| Unversioned items pre-ticked, so any commit with one failed | Unversioned unticked by default; ticking one adds it on commit (TortoiseSVN behaviour); files deleted outside svn are scheduled for delete |
| A ticked folder committed children you had unticked | Commit refuses and names them |
| Failed commit cleared your message; Checkout closed the dialog mid-run; New file/Rename used `window.prompt`, which Electron doesn't implement | Fixed |

Not ported: SVN Studio's light theme (the app is dark-only) and its model
picker / endpoint settings (the review model is fixed).

## Git Studio tab

A port of Git Pilot (`C:\Users\wasim\chatgpt\git-pilot`) as a tab next to SVN
Studio. It covers everything Git Pilot does:

- **Repositories:** a sidebar of recent repositories, plus open, clone and
  create (`git init`). The last repository and tab are restored when you come
  back, and Ctrl+O opens a repository.
- **Local files:** an explorer with search, change badges, and a dot on each
  file that is already on the upstream branch.
- **Changes:** stage, unstage, discard (with a confirmation dialog) and commit
  (Ctrl+Enter).
- **Sync:** fetch, fast-forward-only pull, and push. A first push sets the
  upstream. Push is blocked if a file is over 100 MB, and if no credential is
  stored it signs in through Git Credential Manager and retries.
- **History and branches:** commit history with copy-hash, and branches:
  switch, create, and merge (the working tree must be clean, and a conflict
  aborts the merge).
- **Account & remote:** commit identity (per repository or global), the remote
  URL, Git Credential Manager sign-in, a recovery dialog when GitHub reports
  "repository not found", and buttons to open the repository in Explorer or
  PowerShell.

Requires Git for Windows. Credentials stay in Windows Credential Manager, and
Git Studio never sees or stores them. Git runs in the main process
(`electron/git/`), never through a shell.

### Behaviour that differs from Git Pilot (bug fixes)

| Git Pilot | Git Studio |
|---|---|
| Clone URL passed straight to `git clone`, so `--upload-pack=<cmd>` ran a program | URL goes after `--`; URLs, branch names and remote names that start with `-` are rejected |
| File names were git pathspecs (`[ab].txt` also staged `a.txt`); big selections could overflow the Windows command line | `--literal-pathspecs`, and file operations run in batches |
| Untracked folders were collapsed to `dir/`, which Discard's `git clean -f` silently skipped | Each untracked file is listed and discarded |
| A new repository with no commits showed "Detached HEAD" and refused to push | Shows its branch name; pushing with nothing committed says so |
| Unstaging a staged rename left the old path's deletion staged | Both sides are unstaged |
| Unstage with an untracked file selected failed | Stage and Unstage act only on the selected files they apply to |
| Settings could not add a remote until a name and email were filled in | Saves only what changed |
| A hung git (e.g. a credential prompt) was killed, but its children weren't | The whole process tree is killed at the timeout |
| Status refresh took ~12 git calls in dependent rounds (~2 s here) | 7 calls in one round, using porcelain v2 (~0.75 s) |
| Discard used `window.confirm` | Uses the app's own dialog |
| Status changes made outside the app went unnoticed until Refresh | Refreshes quietly when the window regains focus |

Not ported: Git Pilot's light/system theme picker (Imaginarium is dark-only and
follows the accent from Settings) and its browser demo mode.

## Agent mode (chat)

The **Agent** button in the chat composer replaces the old Web toggle. Turning
it on runs each message through a tool-using loop, ported from Odysseus
`src/agent_loop.py`. Choose a **workspace** folder from the chip next to the
button. The file tools can only reach files inside that folder: paths are
workspace-relative, and `..`, absolute paths and junctions that escape it are
rejected.

| Tool | What it does | Approval |
|---|---|---|
| `list_dir`, `read_file`, `search_files` | Browse and read the workspace | No |
| `write_file` | Create or overwrite a workspace file | **Always** |
| `run_command` | PowerShell in the workspace (60 s timeout, process tree killed) | **Always** |
| `web_search`, `fetch_url` | OrioSearch / fetch a page as text | Once workspace files have been read; always for private-network hosts |

The second approval rule is a taint gate. After the agent has read your files,
anything that could send data off the machine needs your approval.

**How the loop works**
- A round limit ends in a **Continue** button, and there is a tool-call budget.
- A loop-breaker catches repeated identical calls.
- If the model says it will do something without calling a tool, it is nudged
  up to twice.
- A final round forces an answer, and if that fails a synthesis step writes one.
- Tool output goes back to the model wrapped as untrusted data.
- The model can call tools with fenced blocks (```` ```read_file ````), or with
  Gemma 4's native `<|tool_call>call:name{…}` syntax, which it tends to use
  whatever the prompt asks.

**Context management**
- The agent rebuilds the model's context from its own message list each round
  (`LlmEngine.generateFrom`).
- At 85% of the input budget (window − max output − 256), the older half of
  the turn is compacted into a summary. The current request is kept verbatim,
  and a tool call is never split from its result.
- Past that, trimming drops the oldest messages outside the last 10, then
  truncates.
- Summaries of earlier chat history are saved with the conversation.
- The composer shows the current usage as `CTX used/budget`.

## Web search (optional)

Research and the agent's `web_search` tool call `/api/search` and `/api/extract`, which
the main process forwards to a local **OrioSearch** instance (Tavily-compatible)
at `http://localhost:8005`. Override with the `ORIOSEARCH_URL` environment
variable. Without it running, search reports a clean error and the model answers
from its own knowledge.

## Layout

```
electron/       main.ts (app:// protocol, model registry + streaming, IPC)
                preload.ts (the renderer's entire native surface)
                svn/ (svn CLI discovery + operations, AI context, settings, IPC)
                git/ (git operations, recent repositories, IPC)
                agent/ (workspace-sandboxed file/command/fetch tools, IPC)
scripts/        dev.mjs · build-electron.mjs · vendor-assets.mjs
src/lib/        desktop (bridge) · modelStore (replaces the OPFS cache) ·
                engine · models · webgpu · pdf · search · history · themes · ui ·
                agent/ (loop, protocol, context, tools, prompt, session)
src/state/      LlmContext.tsx — status, settings, chat, history, theme
src/components/ shell/ · chat/ · research/ · SettingsPanel
src/routes/     Research · PdfTools · SvnStudio · GitStudio · About · Privacy
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
