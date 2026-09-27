
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  protocol,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { registerSvnIpc } from './svn/ipc';
import { registerGitIpc } from './git/ipc';
import { registerGoogleIpc } from './google/ipc';
import { registerAuth0Ipc } from './auth0/ipc';
import { registerAgentIpc } from './agent/ipc';
import { registerSearchIpc } from './search/ipc';
import { search as searchWeb } from './search/tavily';
import { httpFetch } from './oauth/http';
import { migrateLegacyUserData } from './migrateUserData';

const SCHEME = 'app';
const HOST = 'imaginarium';
const APP_ORIGIN = `${SCHEME}://${HOST}`;

const migration = migrateLegacyUserData();
if (migration.moved) console.log(`[omni-studio] moved settings from ${migration.from} to ${migration.to}`);
else if (migration.reason === 'failed') console.warn('[omni-studio] could not move the old settings folder:', migration.error);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

const RENDERER_ROOT = path.join(__dirname, '..', 'dist');

const SEARCH_API = process.env.ORIOSEARCH_URL ?? 'http://localhost:8005';


interface ModelEntry {
  id: string;
  label: string;
  path: string;
  name: string;
  size: number;
  managed: boolean;
  addedAt: number;
  lastUsedAt: number | null;
}

interface Registry {
  version: 2;
  models: ModelEntry[];
}

type RegistryV1 = Record<
  string,
  { path: string; name: string; size: number; managed: boolean; linkedAt: number }
>;

const registryPath = () => path.join(app.getPath('userData'), 'models.json');
const managedDir = () => path.join(app.getPath('userData'), 'models');

let registry: Registry = { version: 2, models: [] };

const labelFromFileName = (fileName: string) =>
  fileName.replace(/\.litertlm$/i, '') || fileName;

const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function loadRegistry(): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(registryPath(), 'utf8'));
  } catch {
    registry = { version: 2, models: [] };
    return;
  }

  if (raw && typeof raw === 'object' && 'models' in raw) {
    const parsed = raw as Registry;
    registry = { version: 2, models: parsed.models ?? [] };
    return;
  }

  const v1 = (raw ?? {}) as RegistryV1;
  registry = {
    version: 2,
    models: Object.values(v1)
      .filter((e) => e && typeof e.path === 'string')
      .map((e) => ({
        id: randomUUID(),
        label: labelFromFileName(e.name ?? path.basename(e.path)),
        path: e.path,
        name: e.name ?? path.basename(e.path),
        size: e.size ?? 0,
        managed: Boolean(e.managed),
        addedAt: e.linkedAt ?? Date.now(),
        lastUsedAt: null,
      })),
  };
  await saveRegistry();
  console.log(`[imaginarium] migrated ${registry.models.length} model(s) to v2`);
}

async function saveRegistry(): Promise<void> {
  await mkdir(path.dirname(registryPath()), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
}

const MAGIC = 'LITERTLM';
const MIN_MODEL_BYTES = 50 * 1024 * 1024;

async function inspectModel(filePath: string): Promise<ModelEntry> {
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error(`${filePath} is not a file.`);

  if (st.size < MIN_MODEL_BYTES) {
    const mb = (st.size / 1e6).toFixed(1);
    throw new Error(
      `This file is only ${mb} MB — far too small to be a model. ` +
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
        'That file is an HTML page, not a model. Gated repos return a login ' +
          'page when you download signed out — accept the license, download the ' +
          'real .litertlm, and add that.',
      );
    }
    throw new Error(
      `Not a valid .litertlm file (expected magic "LITERTLM", got "${magic}").`,
    );
  }

  const name = path.basename(filePath);
  return {
    id: randomUUID(),
    label: labelFromFileName(name),
    path: filePath,
    name,
    size: st.size,
    managed: false,
    addedAt: Date.now(),
    lastUsedAt: null,
  };
}

async function addModel(filePath: string, managed = false): Promise<ModelEntry> {
  const candidate = await inspectModel(filePath);
  const existing = registry.models.find((m) => samePath(m.path, filePath));
  if (existing) {
    existing.size = candidate.size;
    existing.name = candidate.name;
    existing.managed = existing.managed || managed;
    await saveRegistry();
    return existing;
  }
  candidate.managed = managed;
  registry.models.push(candidate);
  await saveRegistry();
  return candidate;
}

async function getModel(id: string): Promise<ModelEntry | null> {
  const entry = registry.models.find((m) => m.id === id);
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
    registry.models = registry.models.filter((m) => m.id !== id);
    await saveRegistry();
    return null;
  }
}

async function listModels(): Promise<ModelEntry[]> {
  const alive: ModelEntry[] = [];
  let changed = false;
  for (const entry of registry.models) {
    const st = await stat(entry.path).catch(() => null);
    if (st?.isFile()) {
      if (st.size !== entry.size) {
        entry.size = st.size;
        changed = true;
      }
      alive.push(entry);
    } else {
      changed = true;
    }
  }
  if (changed) {
    registry.models = alive;
    await saveRegistry();
  }
  return alive;
}

async function removeModel(id: string): Promise<void> {
  const entry = registry.models.find((m) => m.id === id);
  if (!entry) return;
  registry.models = registry.models.filter((m) => m.id !== id);
  await saveRegistry();
  if (entry.managed) await rm(entry.path, { force: true });
}

async function renameModel(id: string, label: string): Promise<ModelEntry | null> {
  const entry = registry.models.find((m) => m.id === id);
  if (!entry) return null;
  entry.label = label.trim() || labelFromFileName(entry.name);
  await saveRegistry();
  return entry;
}

async function touchModel(id: string): Promise<void> {
  const entry = registry.models.find((m) => m.id === id);
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  await saveRegistry();
}


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
  if (!filePath.startsWith(RENDERER_ROOT + path.sep) && filePath !== RENDERER_ROOT) {
    return new Response('Forbidden', { status: 403, headers: ISOLATION_HEADERS });
  }

  let st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) {
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

const MODEL_HEADERS: Record<string, string> = {
  'content-type': 'application/octet-stream',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
};

async function serveModel(url: URL): Promise<Response> {
  const modelId = decodeURIComponent(url.pathname.replace(/^\/model\/?/, ''));
  const entry = await getModel(modelId);
  if (!entry) {
    return new Response(
      'That model is no longer in the library — the file may have been moved or deleted.',
      { status: 404, headers: MODEL_HEADERS },
    );
  }
  void touchModel(entry.id);
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
    if (url.pathname === '/api/search') {
      const { query, max_results } = await request.json();
      return new Response(JSON.stringify({ results: await searchWeb(query, max_results) }), {
        headers: { 'content-type': 'application/json', ...ISOLATION_HEADERS },
      });
    }
    const upstream = await httpFetch(SEARCH_API + target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: await request.text(),
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


let downloadAbort: AbortController | null = null;

async function downloadModel(
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
        `Failed to download ${fileName} (HTTP ${res.status}). Gated repos need ` +
          'you to be signed in — download it in a browser and add the file instead.',
      );
    }
    const totalHeader = res.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : null;

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

    await inspectModel(partPath).catch(async (err) => {
      await rm(partPath, { force: true });
      throw err;
    });

    await rm(finalPath, { force: true });
    await rename(partPath, finalPath);
    return await addModel(finalPath, true);
  } catch (err) {
    await rm(partPath, { force: true });
    if ((err as Error).name === 'AbortError') throw new Error('DOWNLOAD_CANCELLED');
    throw err;
  } finally {
    downloadAbort = null;
  }
}


function registerIpc(): void {
  registerSvnIpc();
  registerGitIpc();
  registerGoogleIpc();
  registerAuth0Ipc();
  registerSearchIpc();
  registerAgentIpc();

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    searchApi: SEARCH_API,
  }));

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    const { protocol: scheme } = new URL(url);
    if (!['https:', 'http:', 'mailto:'].includes(scheme)) {
      throw new Error(`Refusing to open ${scheme} URL: ${url}`);
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('model:list', () => listModels());
  ipcMain.handle('model:get', (_e, id: string) => getModel(id));
  ipcMain.handle('model:remove', (_e, id: string) => removeModel(id));
  ipcMain.handle('model:rename', (_e, id: string, label: string) =>
    renameModel(id, label),
  );

  ipcMain.handle('model:add', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Add LiteRT-LM models',
      buttonLabel: 'Add to library',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: 'LiteRT-LM model', extensions: ['litertlm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { added: [], rejected: [] };

    const added: ModelEntry[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for (const filePath of result.filePaths) {
      try {
        added.push(await addModel(filePath));
      } catch (err) {
        rejected.push({
          name: path.basename(filePath),
          reason: (err as Error).message,
        });
      }
    }
    return { added, rejected };
  });

  ipcMain.handle('model:revealInFolder', async (_e, id: string) => {
    const entry = await getModel(id);
    if (entry) shell.showItemInFolder(entry.path);
  });

  ipcMain.handle(
    'model:download',
    async (event, url: string, fileName: string): Promise<ModelEntry> =>
      downloadModel(url, fileName, (received, total) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('model:downloadProgress', { received, total });
        }
      }),
  );

  ipcMain.handle('model:cancelDownload', () => {
    downloadAbort?.abort();
  });

  ipcMain.handle('storage:usage', async () => {
    let bytes = 0;
    for (const entry of registry.models) {
      if (entry.managed) bytes += entry.size;
    }
    return { managedBytes: bytes, directory: managedDir() };
  });
}


function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0e12',
    autoHideMenuBar: true,
    ...(app.isPackaged
      ? {}
      : { icon: path.join(__dirname, '..', 'build', 'icon.ico') }),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0c0e12',
      symbolColor: '#8b8597',
      height: 68,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: IS_DEV || !app.isPackaged,
    },
  });

  win.once('ready-to-show', () => win.show());

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
