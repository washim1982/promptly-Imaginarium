# OMNI-STUDIO — Windows desktop

A native Windows build of the OMNI-STUDIO AI workspace (formerly Imaginarium). Same interface as the web
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
`%APPDATA%\OMNI-STUDIO\models.json` — a list of entries, each with a generated
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
`%APPDATA%\OMNI-STUDIO\models` are deleted from disk, and the confirm dialog says
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
  `%APPDATA%\OMNI-STUDIO\svn-settings.json`.
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

### Scan: find and remove credentials (not in Git Pilot)

**Scan** in the repository header looks for tokens, keys and passwords in two
places: the files as they are now (tracked and untracked, respecting
`.gitignore`) and **every blob in the history** — a credential deleted in a
later commit is still in the repository, which is the case that matters.

It knows AWS keys, GitHub/GitLab/Slack/Stripe/npm tokens, Google API keys and
OAuth client secrets, OpenAI and Anthropic keys, private-key blocks, JWTs,
connection strings with a password, and `password` / `secret` / `api_key`
assignments. Obvious placeholders (`changeme`, `process.env.X`, `${VAR}`,
`your-secret-here`) are ignored, and a line marked `secret-scan:ignore` is
skipped. Findings are listed masked (`ghp_••••••Qw`) with the file, line and
the commit each one came from; **the values themselves never leave the main
process**.

Tick what to remove, then confirm. Removal:
- writes a **bundle of the whole history first** (`.git/imaginarium-backups/`),
  so the rewrite can be undone with `git clone <bundle>`;
- replaces the values with `***REMOVED***` in your files and in every commit
  that contains them, using git plumbing — messages, authors and dates are
  preserved, and commits from before the credential appeared keep their hashes;
- keeps your uncommitted changes;
- then offers **Force-push**, which uses `--force-with-lease`, so it is refused
  if someone else pushed since your last fetch.

**Deep scan with AI** (optional, in the same dialog) is a second pass for what
the patterns can't know. A cheap filter in the main process picks lines holding
a long random-looking value, or any value assigned to a secret-sounding name
(camelCase and SCREAMING_SNAKE included), skipping hashes, UUIDs, version
numbers and plain URLs. Those lines go to **gemma-4-E4B-it-web** running in the
app — loaded if another model is active, as the SVN review does — whichsays
for each one whether it is a real credential.

- It only ever **adds** suspects; it never unticks or overrules the rules.
- Its findings arrive **unticked**, grouped under "Flagged by the model — check
  each one", with the kind it guessed.
- Nothing leaves the machine, but the candidate lines *are* shown to the local
  model, which the panel states plainly.
- A small model is fallible in both directions: in testing it caught a
  random-looking key with a neutral name that the rules missed, and it passed
  over a wordy passphrase (`thunder-marmalade-91-vault`). Treat it as a second
  opinion, not a guarantee.

Limits worth knowing:
- Files over 5 MB and binary files aren't scanned; the count of skipped files
  is shown so this is never silent.
- Until you force-push, the old commits stay reachable locally through
  `origin/<branch>`. The UI says so.
- Annotated tags are left pointing at the old commits, and commit signatures on
  rewritten commits are dropped (a signature can't cover changed content). Both
  are reported.
- **Rewriting is not a substitute for rotating.** Anything pushed, cloned, or
  captured by CI must be treated as leaked: revoke and reissue it.

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

Not ported: Git Pilot's light/system theme picker (OMNI-STUDIO is dark-only and
follows the accent from Settings) and its browser demo mode.

## Chat sidebar

The chat page has a sidebar on the left. Drag its right edge to resize it
(240–560 px, never squeezing the chat below ~420 px); double-click the edge to
reset, or focus it and use the arrow keys. Dragging it narrow snaps it to an
icon rail, and expanding brings back the width you had. The width, the
collapsed state and the open section are all remembered.

- **New chat**
- **Email:** your Gmail inbox. You can search it with Gmail syntax (`from:`,
  `subject:`, `has:attachment`, …), open a message, and **Attach to chat**.
- **Google Drive:** browse My Drive folder by folder, or search all of Drive.
  Docs, Sheets and Slides are exported as text. PDFs are read on this PC with
  pdf.js. Text files are read as-is.
- **Workspace:** the agent's workspace folder as a file tree. You can preview a
  file and attach it, change the folder, or toggle Agent mode.
- **History:** your saved chats, with a filter.

You can send a message with attachments and no text; it then asks for a
summary. The model receives each attachment inside the same untrusted-data
wrapper it uses for tool output. The wrapper is escaped, so an email saying
"ignore your instructions…" is treated as content, not a command. Attachments
share at most 60% of the context budget and are cut head+tail to fit. Sent
messages show a chip per attachment, and the full text is saved with the chat
so reloading it keeps the context. In Agent mode, attaching private content
turns on the approval gate for web tools, just as reading workspace files does.

### App login (Auth0)

The **Log in (optional)** button sits at the bottom of the chat sidebar.
Chatting never needs it, but **Email and Google Drive do**: until you log in,
those sections show "Log in to use Email". The main process enforces this too,
not just the UI.

A connected Google account belongs to the Auth0 user who connected it:
- **Logging out** locks Gmail/Drive, and the same user gets them back after
  logging in again.
- **A different user** logging in on this PC never sees that mailbox. The link
  is dropped and they connect their own.

How login works:
- It uses Authorization Code + PKCE in your browser, with a fixed loopback
  callback.
- There is no client secret: a Native app is a public client.
- The ID token is checked for issuer, audience, expiry and nonce.
- The refresh token is encrypted with DPAPI and confirmed with Auth0 once per
  launch (rotated if rotation is on). A revoked session logs out; being offline
  does not.
- **Log out** revokes the refresh token at Auth0.

Setup in the [Auth0 Dashboard](https://manage.auth0.com/) → Applications → your
**Native** application:

1. **Settings → Application URIs → Allowed Callback URLs:** add
   `http://127.0.0.1:47823/callback` exactly (Auth0 matches the port too), then
   **Save**.
2. **Settings → Advanced → Grant Types:** make sure **Authorization Code** and
   **Refresh Token** are ticked (the defaults for Native apps).
3. *(Recommended)* **Settings → Refresh Token Rotation:** turn on Rotation.
4. **Connections** tab: enable the login methods you want, e.g.
   Username-Password and/or Google.
5. In OMNI-STUDIO, click **Log in (optional)**, paste the **Domain** (e.g.
   `your-tenant.us.auth0.com`) and **Client ID** from Settings → Basic
   Information, then **Save** → **Log in**. Auth0's login page opens in your
   browser.

Alternatively, put the values in an untracked `.env` (copy `.env.example`):
`npm run dev` loads it, and environment variables win over anything saved in
the app. Never put the client secret anywhere; it isn't used. If port 47823 is taken by
another program, the app says so instead of hanging.

The Auth0 login and the Google connection are separate: logging in with Auth0's
Google button does *not* grant Gmail access. You still click **Connect Google
account** once, which uses the Google client below.

### Google account (Email & Drive)

Requires the Auth0 login above. Access is **read-only** (`gmail.readonly`, `drive.readonly`), so nothing can be
sent, changed or deleted. Mail and files are read by the main process, and only
the local model sees them. OMNI-STUDIO signs in with the flow Google recommends
for desktop apps:
- The consent page opens in your own browser, and Google redirects back to a
  one-time listener on `127.0.0.1`. The request is protected with PKCE and a
  random `state` value.
- The refresh token is encrypted with Windows DPAPI (`safeStorage`) and never
  reaches the renderer.
- **Disconnect** revokes the token at Google and deletes it.

You need your own OAuth client. Google does not let one be shipped inside the
app, and setting one up is free and takes about 5 minutes.

1. **Create a project.** Go to
   [console.cloud.google.com](https://console.cloud.google.com/) and create a
   new project, e.g. "OMNI-STUDIO".
2. **Enable the APIs.** Under APIs & Services → Library, enable **Gmail API**
   and **Google Drive API**.
3. **Set up the OAuth consent screen.** Under APIs & Services → OAuth consent
   screen (called "Google Auth Platform" in newer consoles):
   - User type: **External**. Give it an app name and your email.
   - Scopes: add `.../auth/gmail.readonly` and `.../auth/drive.readonly`.
   - Audience / **Test users:** add the Gmail address(es) you will connect.
4. **Create the client.** Under Credentials → Create credentials → **OAuth
   client ID**, choose Application type **Desktop app**, then Create. Copy the
   **Client ID** and **Client secret**.
5. **Connect in OMNI-STUDIO.** Log in (Auth0) first. Then open Chat → sidebar → **Email**, paste both
   values, then **Save** → **Connect Google account**. Your browser opens.
   Pick the account and continue past the "Google hasn't verified this app"
   screen (it's your own app: Advanced → Go to …). Leave both permissions
   ticked. The sidebar then shows your inbox.

Alternatively, put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in
`.env` (copy `.env.example`; `npm run dev` loads it). They take precedence over
the saved values.

**Credentials and version control.** `.env` and the app's own credential files
(`auth0-client.json`, `google-oauth-client.json`, the encrypted `*.bin` token
files) are in `.gitignore`; only `.env.example`, with placeholder names, is
committed. Client IDs and tokens the app saves at runtime live in
`%APPDATA%\OMNI-STUDIO\`, outside the repository.

**One set of credentials for every PC.** The Auth0 application and the Google
OAuth client are created once, not per machine: each user just logs in and
approves access on their own PC, where their own tokens are stored. While the
Google project is in Testing, each of those accounts must be on its Test users
list (max 100, re-consent every 7 days).

Notes:
- While the consent screen is in **Testing** status, Google expires sign-ins
  after **7 days**. OMNI-STUDIO then says the sign-in expired; click Connect
  again. Publishing the app to Production (APIs & Services → OAuth consent
  screen → Publish) removes the limit. Restricted scopes such as Gmail then
  show the unverified-app warning, which is fine for personal use.
- One Google account is connected at a time. Disconnect it to switch accounts.
- Email attachments (the files on a message) are listed but not read. Scanned
  PDFs with no text layer can't be read either; use PDF Tools → OCR.

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
| `append_file` | Add to the end of a workspace file, creating it if needed (2 MB cap) | **Always** |
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

**Large jobs and the context window**

A task like "read these 15 documents and write one summary file" is limited by
the model's context window, not by the tools. At the default 8192 it does not
fit: the agent reads a few files, compaction summarises them away, and it can
end up listing the folder again instead of finishing. Measured here with 15
documents of ~150 lines each: **8192 fails, 32768 succeeds** (Settings →
Context window, then reload the model — it sizes the KV cache, so it costs GPU
memory). The agent now says so itself when compaction fires twice in one turn.
Alternatively, ask in smaller steps ("summarise docs 1–5 into notes.md", then
extend it) — `append_file` exists for exactly this: the agent writes the first
section, then adds each later one without re-sending the document it has
already written.

The instruction also survives compaction now: the most recent thing you asked
for is pinned alongside the current message, so a task given one message
earlier ("…save it as FINAL-VERDICT.md") is not summarised away mid-run.

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
                git/ (git operations, credential scan + history rewrite, IPC)
                google/ (OAuth sign-in, read-only Gmail + Drive, IPC)
                auth0/ (optional app login, gates Google) · oauth/ (shared PKCE + loopback)
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
