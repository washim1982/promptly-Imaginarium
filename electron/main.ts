// Imaginarium desktop — main process.
//
// Three jobs:
//   1. Serve the renderer over a custom `app://` scheme with COOP/COEP so the
//      page is cross-origin isolated. LiteRT-LM needs SharedArrayBuffer, and
//      `file://` can never be isolated — hence the protocol handler.
//   2. Stream the multi-GB `.litertlm` model straight off disk to the renderer
//      (`app://imaginarium/model/<id>`), so nothing is ever copied into OPFS
//      the way the browser build had to.
//   3. Proxy `/api/search` and `/api/extract` to the local OrioSearch API,
//      replacing the nginx/Vite reverse proxy the web build relied on.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  protocol,
} from 'electron';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const SCHEME = 'app';
const HOST = 'imaginarium';
const APP_ORIGIN = `${SCHEME}://${HOST}`;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

// Where the packaged renderer lives: dist-electron/main.cjs -> ../dist
const RENDERER_ROOT = path.join(__dirname, '..', 'dist');

const SEARCH_API = process.env.ORIOSEARCH_URL ?? 'http://localhost:8005';

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
//
// The browser build cached model bytes in OPFS. On the desktop we only remember
// *where the file is*, which avoids duplicating ~2 GB per model. `managed` marks
// files this app downloaded into userData (safe for us to delete); a file the
// user picked from their own disk is never deleted, only forgotten.

interface ModelEntry {
  path: string;
  name: string;
  size: number;
  managed: boolean;
  linkedAt: number;
}

type Registry = Record<string, ModelEntry>;

const registryPath = () => path.join(app.getPath('userData'), 'models.json');
const managedDir = () => path.join(app.getPath('userData'), 'models');

let registry: Registry = {};

async function loadRegistry(): Promise<void> {
  try {
    registry = JSON.parse(await readFile(registryPath(), 'utf8')) as Registry;
  } catch {
    registry = {}; // first run
  }
}

async function saveRegistry(): Promise<void> {
  await mkdir(path.dirname(registryPath()), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
}

// Every .litertlm file begins with the 8-byte ASCII magic "LITERTLM". Checking
// it (plus a sane minimum size) catches the classic failure mode: a gated
// Hugging Face download performed while signed out saves an HTML login page.
const MAGIC = 'LITERTLM';
const MIN_MODEL_BYTES = 50 * 1024 * 1024;

/** Validate a candidate model file without reading more than 8 bytes of it. */
async function inspectModel(filePath: string): Promise<ModelEntry> {
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error(`${filePath} is not a file.`);

  if (st.size < MIN_MODEL_BYTES) {
    const mb = (st.size / 1e6).toFixed(1);
    throw new Error(
      `This file is only ${mb} MB — far too small to be a model (expected ~2 GB). ` +
        'You probably saved a Hugging Face web page. Use the file’s download ' +
        'button on the repo’s "Files" tab (not the preview link), then choose it here.',
    );
  }

  const handle = await open(filePath, 'r');
  let magic: string;
  try {
    const buf = Buffer.alloc(8);
    await handle.read(buf, 0, 8, 0);
    magic = buf.toString('latin1');
  } finally {
    await handle.close();
  }

  if (magic !== MAGIC) {
    const lower = magic.toLowerCase();
    if (lower.startsWith('<!doc') || lower.startsWith('<html') || lower.startsWith('<')) {
      throw new Error(
        'That file is an HTML page, not a model. Gemma is gated — sign in to ' +
          'Hugging Face and accept the license, then download the real ' +
          '.litertlm (~2 GB) and choose it here.',
      );
    }
    throw new Error(
      `Not a valid .litertlm file (expected magic "LITERTLM", got "${magic}").`,
    );
  }

  return {
    path: filePath,
    name: path.basename(filePath),
    size: st.size,
    managed: false,
    linkedAt: Date.now(),
  };
}

/** Registry entry for a model, re-checked against disk (files can move away). */
async function linkedModel(modelId: string): Promise<ModelEntry | null> {
  const entry = registry[modelId];
  if (!entry) return null;
  try {
    const st = await stat(entry.path);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size !== entry.size) {
      entry.size = st.size;
      await saveRegistry();
    }
    return entry;
  } catch {
    delete registry[modelId]; // file was moved or deleted since we linked it
    await saveRegistry();
    return null;
  }
}

async function unlinkModel(modelId: string): Promise<void> {
  const entry = registry[modelId];
  if (!entry) return;
  delete registry[modelId];
  await saveRegistry();
  // Only remove files we downloaded ourselves — never the user's own file.
  if (entry.managed) await rm(entry.path, { force: true });
}

// ---------------------------------------------------------------------------
// app:// protocol
// ---------------------------------------------------------------------------

// Cross-origin isolation. Required for SharedArrayBuffer, which LiteRT-LM's
// wasm runtime uses; without these the engine fails to start.
const ISOLATION_HEADERS: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  // Tesseract's language data ships pre-gzipped and is decompressed by the
  // library itself — serve it as an opaque gzip blob, NOT with
  // Content-Encoding, or Chromium will double-decompress it.
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream',
};

const mimeFor = (file: string) =>
  MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

function fileResponse(
  filePath: string,
  size: number,
  headers: Record<string, string>,
): Response {
  const body = Readable.toWeb(
    createReadStream(filePath),
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: { 'content-length': String(size), ...headers },
  });
}

async function serveStatic(url: URL): Promise<Response> {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  let filePath = path.join(RENDERER_ROOT, path.normalize(rel));
  // Reject traversal outside the bundled renderer.
  if (!filePath.startsWith(RENDERER_ROOT + path.sep) && filePath !== RENDERER_ROOT) {
    return new Response('Forbidden', { status: 403, headers: ISOLATION_HEADERS });
  }

  let st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) {
    // SPA fallback. The app uses HashRouter so this is mostly belt-and-braces.
    filePath = path.join(RENDERER_ROOT, 'index.html');
    st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) {
      return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS });
    }
  }

  return fileResponse(filePath, st.size, {
    'content-type': mimeFor(filePath),
    ...ISOLATION_HEADERS,
  });
}

// The model stream is fetched by the renderer, which may be running on
// http://localhost:5173 in dev — so it needs permissive CORS/CORP rather than
// the same-origin headers used for the app shell.
const MODEL_HEADERS: Record<string, string> = {
  'content-type': 'application/octet-stream',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
};

async function serveModel(url: URL): Promise<Response> {
  const modelId = decodeURIComponent(url.pathname.replace(/^\/model\/?/, ''));
  const entry = await linkedModel(modelId);
  if (!entry) {
    return new Response(`No model file is linked for "${modelId}".`, {
      status: 404,
      headers: MODEL_HEADERS,
    });
  }
  return fileResponse(entry.path, entry.size, MODEL_HEADERS);
}

const API_ROUTES: Record<string, string> = {
  '/api/search': '/search',
  '/api/extract': '/extract',
};

async function serveApi(url: URL, request: Request): Promise<Response> {
  const target = API_ROUTES[url.pathname];
  if (!target) {
    return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS });
  }
  try {
    const upstream = await fetch(SEARCH_API + target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: await request.arrayBuffer(),
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        ...ISOLATION_HEADERS,
      },
    });
  } catch (err) {
    // The search backend is optional — surface a clean error the UI can show.
    return new Response(
      JSON.stringify({
        error: `Search backend unreachable at ${SEARCH_API}: ${(err as Error).message}`,
      }),
      {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...ISOLATION_HEADERS,
        },
      },
    );
  }
}

function registerProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/model')) return await serveModel(url);
      if (url.pathname.startsWith('/api/')) return await serveApi(url, request);
      return await serveStatic(url);
    } catch (err) {
      return new Response(`Internal error: ${(err as Error).message}`, {
        status: 500,
        headers: ISOLATION_HEADERS,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Model download (main-process, streamed to disk)
// ---------------------------------------------------------------------------
//
// The browser build accumulated the whole download in memory before writing it.
// Here it streams straight to a .part file in userData and is renamed on
// success, so a cancelled or failed download never leaves a half-file behind.

let downloadAbort: AbortController | null = null;

async function downloadModel(
  modelId: string,
  url: string,
  fileName: string,
  onProgress: (received: number, total: number | null) => void,
): Promise<ModelEntry> {
  await mkdir(managedDir(), { recursive: true });
  const finalPath = path.join(managedDir(), fileName);
  const partPath = `${finalPath}.part`;

  downloadAbort = new AbortController();
  try {
    const res = await fetch(url, { signal: downloadAbort.signal });
    if (!res.ok || !res.body) {
      throw new Error(
        `Failed to download ${fileName} (HTTP ${res.status}). Gemma repos are ` +
          'gated — use "Browse for a .litertlm file" instead.',
      );
    }
    const totalHeader = res.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : null;

    // Count bytes in-line rather than teeing the stream, and throttle the
    // reports — a 2 GB download is ~30k chunks, which is far too many IPC
    // messages to forward one-for-one.
    let received = 0;
    let lastReport = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.byteLength;
        const now = Date.now();
        if (now - lastReport >= 100) {
          lastReport = now;
          onProgress(received, total);
        }
        cb(null, chunk);
      },
      flush(cb) {
        onProgress(received, total);
        cb();
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as never),
      counter,
      createWriteStream(partPath),
    );

    const entry = await inspectModel(partPath).catch(async (err) => {
      await rm(partPath, { force: true }); // never keep an HTML error page
      throw err;
    });

    await rm(finalPath, { force: true });
    await rename(partPath, finalPath);

    registry[modelId] = {
      ...entry,
      path: finalPath,
      name: fileName,
      managed: true,
      linkedAt: Date.now(),
    };
    await saveRegistry();
    return registry[modelId];
  } catch (err) {
    await rm(partPath, { force: true });
    // Electron flattens errors across IPC, so the `AbortError` name is lost —
    // use a message the renderer can recognise instead.
    if ((err as Error).name === 'AbortError') throw new Error('DOWNLOAD_CANCELLED');
    throw err;
  } finally {
    downloadAbort = null;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    searchApi: SEARCH_API,
  }));

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    // Hand only web and mail links to the OS. Anything else (file:, and the
    // various protocol handlers that can launch programs) is refused.
    const { protocol: scheme } = new URL(url);
    if (!['https:', 'http:', 'mailto:'].includes(scheme)) {
      throw new Error(`Refusing to open ${scheme} URL: ${url}`);
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('model:linked', (_e, modelId: string) => linkedModel(modelId));

  ipcMain.handle('model:browse', async (event, modelId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: `Choose the ${modelId} model file`,
      buttonLabel: 'Use this model',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'LiteRT-LM model', extensions: ['litertlm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const entry = await inspectModel(result.filePaths[0]);
    registry[modelId] = entry;
    await saveRegistry();
    return entry;
  });

  ipcMain.handle('model:unlink', (_e, modelId: string) => unlinkModel(modelId));

  ipcMain.handle('model:revealInFolder', async (_e, modelId: string) => {
    const entry = await linkedModel(modelId);
    if (entry) shell.showItemInFolder(entry.path);
  });

  ipcMain.handle(
    'model:download',
    async (
      event,
      modelId: string,
      url: string,
      fileName: string,
    ): Promise<ModelEntry> =>
      downloadModel(modelId, url, fileName, (received, total) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('model:downloadProgress', { modelId, received, total });
        }
      }),
  );

  ipcMain.handle('model:cancelDownload', () => {
    downloadAbort?.abort();
  });

  ipcMain.handle('storage:usage', async () => {
    // How much disk the app is responsible for = the models it downloaded.
    let bytes = 0;
    for (const entry of Object.values(registry)) {
      if (entry.managed) bytes += entry.size;
    }
    return { managedBytes: bytes, directory: managedDir() };
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0e12', // --color-ink, so there is no white flash
    autoHideMenuBar: true,
    // Packaged builds take the icon from the .exe (electron-builder stamps it
    // in); in dev there is no .exe of ours, so point Electron at the file
    // directly or the taskbar shows the stock Electron logo.
    ...(app.isPackaged
      ? {}
      : { icon: path.join(__dirname, '..', 'build', 'icon.ico') }),
    // Keep the web app's own header as the title bar; Windows draws only the
    // caption buttons on top of it. TopNav marks itself as the drag region.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0c0e12',
      symbolColor: '#8b8597', // --color-muted
      height: 68,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Devtools are only useful against a build with sourcemaps.
      devTools: IS_DEV || !app.isPackaged,
    },
  });

  win.once('ready-to-show', () => win.show());

  // One-line startup diagnostic. Both of these are hard requirements for
  // LiteRT-LM, and when they're missing the failure surfaces deep inside wasm —
  // so report them up front where they're actually readable.
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(
        `(async () => ({
           isolated: crossOriginIsolated,
           sab: typeof SharedArrayBuffer !== 'undefined',
           gpu: 'gpu' in navigator ? Boolean(await navigator.gpu.requestAdapter()) : false,
         }))()`,
      )
      .then((r: { isolated: boolean; sab: boolean; gpu: boolean }) => {
        console.log(
          `[imaginarium] crossOriginIsolated=${r.isolated} SharedArrayBuffer=${r.sab} webgpu=${r.gpu}`,
        );
        if (!r.isolated || !r.gpu) {
          console.warn(
            '[imaginarium] the engine will not start without both of the above',
          );
        }
      })
      .catch((err: Error) => console.warn('[imaginarium] probe failed:', err.message));
  });

  // External links open in the OS browser, never in an app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ?? APP_ORIGIN;
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (url.startsWith('http')) void shell.openExternal(url);
    }
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return win;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Must run before `app.ready`: marks app:// as a real, secure, fetchable origin
// (rather than an opaque one), which is what makes cross-origin isolation and
// module imports work from it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await loadRegistry();
    registerProtocol();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
