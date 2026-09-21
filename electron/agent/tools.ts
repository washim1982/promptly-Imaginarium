// Main-process implementations of the agent's tools.
//
// File tools are confined to the workspace folder the user picked: the model
// only ever supplies *relative* paths, which go through the same traversal
// check as SVN Studio, plus a real-path check so a symlink inside the workspace
// can't reach outside it. Which calls need the user's approval is decided in
// the renderer (src/lib/agent/tools.ts) before any of this runs.

import { spawn, execFile } from 'node:child_process';
import { appendFile, mkdir, open as fsOpen, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRelativePath } from '../svn/pathSafety';
import { httpFetch } from '../oauth/http';

const SKIP_DIRS = new Set([
  '.git', '.svn', 'node_modules', 'dist', 'build', 'out', 'release', '.next', '.venv', 'venv',
  '__pycache__', '.idea', '.vs', 'bin', 'obj', 'target', 'dist-electron',
]);
const MAX_READ_BYTES = 400_000;
/** A file the agent builds up with append_file stops here. */
const MAX_APPEND_BYTES = 2_000_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_COMMAND_OUTPUT = 64_000;

/** Resolve a model-supplied relative path, refusing anything outside `root`. */
async function resolveInside(root: string, rel: string, mustExist: boolean): Promise<string> {
  const safe = assertSafeRelativePath(root, rel || '.');
  const target = path.resolve(root, safe);
  const realRoot = await realpath(root);
  // For a file that doesn't exist yet (write_file), check its nearest existing parent.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new Error('Path resolves outside the workspace (through a link).');
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (mustExist) throw new Error(`Not found: ${rel}`);
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export async function listDir(root: string, rel: string): Promise<string> {
  const dir = await resolveInside(root, rel, true);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const e of entries.slice(0, 300)) {
    if (e.isDirectory()) {
      lines.push(`${e.name}/${SKIP_DIRS.has(e.name) ? '  (skipped by search)' : ''}`);
    } else {
      const size = await stat(path.join(dir, e.name)).then((s) => s.size).catch(() => 0);
      lines.push(`${e.name}  (${size} bytes)`);
    }
  }
  if (entries.length > 300) lines.push(`... ${entries.length - 300} more entries`);
  return lines.length ? lines.join('\n') : '(empty directory)';
}

export interface DirEntry {
  name: string;
  /** Workspace-relative, forward slashes. */
  path: string;
  isDir: boolean;
  size: number;
}

/** Structured listing for the sidebar's workspace tree (the tool gets text). */
export async function listEntries(root: string, rel: string): Promise<DirEntry[]> {
  const dir = await resolveInside(root, rel, true);
  const base = assertSafeRelativePath(root, rel || '.').replace(/^\.?\/?$/, '');
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return Promise.all(
    entries.slice(0, 500).map(async (e) => ({
      name: e.name,
      path: base ? `${base.replace(/\/$/, '')}/${e.name}` : e.name,
      isDir: e.isDirectory(),
      size: e.isDirectory() ? 0 : await stat(path.join(dir, e.name)).then((s) => s.size).catch(() => 0),
    })),
  );
}

/** A whole text file, for attaching to a chat message. */
export async function readForAttach(root: string, rel: string): Promise<{ name: string; text: string }> {
  const file = await resolveInside(root, rel, true);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error(`${rel} is a folder.`);
  if (st.size > MAX_READ_BYTES) throw new Error(`${rel} is too large to attach (${Math.round(st.size / 1024)} KB, limit ${MAX_READ_BYTES / 1000} KB).`);
  const buf = await readFile(file);
  if (looksBinary(buf)) throw new Error(`${rel} looks like a binary file.`);
  return { name: path.basename(file), text: buf.toString('utf8') };
}

export async function readTextFile(root: string, rel: string, start?: number, end?: number): Promise<string> {
  const file = await resolveInside(root, rel, true);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error(`${rel} is a directory — use list_dir.`);
  if (st.size > MAX_READ_BYTES) {
    throw new Error(`${rel} is ${st.size} bytes, too large to read whole. Use search_files to find the relevant lines.`);
  }
  const buf = await readFile(file);
  if (looksBinary(buf)) throw new Error(`${rel} looks like a binary file.`);
  const lines = buf.toString('utf8').split(/\r?\n/);
  const from = Math.max(1, Math.floor(start ?? 1));
  const to = Math.min(lines.length, Math.floor(end ?? from + 199));
  const width = String(to).length;
  const body = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
    .join('\n');
  const more = to < lines.length ? `\n... lines ${to + 1}-${lines.length} not shown (use start_line/end_line)` : '';
  return `${rel} (lines ${from}-${to} of ${lines.length})\n${body}${more}`;
}

export async function searchFiles(root: string, pattern: string, glob?: string): Promise<string> {
  if (!pattern) throw new Error('search_files needs a pattern.');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); // not a valid regex: search literally
  }
  // "*.ts" / "src/**/*.py" → a filename filter; kept deliberately simple.
  const globRe = glob
    ? new RegExp(
        '^' +
          glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*\//g, '(?:.*/)?')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.') +
          '$',
        'i',
      )
    : null;
  const realRoot = await realpath(root);
  const hits: string[] = [];
  let filesScanned = 0;

  async function walk(dir: string): Promise<void> {
    if (hits.length >= 60 || filesScanned > 5000) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= 60) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(realRoot, abs).split(path.sep).join('/');
      if (globRe && !globRe.test(rel) && !globRe.test(e.name)) continue;
      const st = await stat(abs).catch(() => null);
      if (!st || st.size > MAX_SEARCH_FILE_BYTES) continue;
      filesScanned += 1;
      const buf = await readFile(abs).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }
  await walk(realRoot);
  if (!hits.length) return `No matches for /${pattern}/${glob ? ` in ${glob}` : ''} (${filesScanned} files searched).`;
  return `${hits.length}${hits.length >= 60 ? '+' : ''} match(es):\n${hits.join('\n')}`;
}

export async function writeTextFile(root: string, rel: string, content: string): Promise<string> {
  const file = await resolveInside(root, rel, false);
  const existing = await stat(file).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`${rel} is a directory.`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return `${existing ? 'Overwrote' : 'Created'} ${rel} (${Buffer.byteLength(content)} bytes).`;
}

/**
 * Add to the end of a workspace file, creating it if needed.
 *
 * Lets a long document be built across many rounds without holding the whole
 * thing in context, which write_file would require (it replaces the file).
 */
export async function appendTextFile(root: string, rel: string, content: string): Promise<string> {
  const file = await resolveInside(root, rel, false);
  const existing = await stat(file).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`${rel} is a directory.`);
  const addition = Buffer.byteLength(content);
  if ((existing?.size ?? 0) + addition > MAX_APPEND_BYTES) {
    throw new Error(`${rel} would exceed ${MAX_APPEND_BYTES / 1000} KB. Start a new file instead.`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  // A newline between chunks, unless the file already ends with one.
  let prefix = '';
  if (existing?.size) {
    const tail = Buffer.alloc(1);
    const handle = await fsOpen(file, 'r');
    try {
      await handle.read(tail, 0, 1, existing.size - 1);
    } finally {
      await handle.close();
    }
    if (tail.toString('utf8') !== '\n') prefix = '\n';
  }
  await appendFile(file, prefix + content, 'utf8');
  const total = (existing?.size ?? 0) + addition + prefix.length;
  return `${existing ? 'Appended to' : 'Created'} ${rel} (+${addition} bytes, ${total} bytes total).`;
}

/**
 * Run a shell command in the workspace. PowerShell on Windows, sh elsewhere.
 * A timeout kills the whole process tree — a plain kill would leave anything
 * the shell spawned still running.
 */
export function runCommand(root: string, command: string, timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          cwd: root,
          windowsHide: true,
        })
      : spawn('/bin/sh', ['-c', command], { cwd: root });
    let out = '';
    let truncated = false;
    const take = (chunk: Buffer) => {
      if (out.length >= MAX_COMMAND_OUTPUT) {
        truncated = true;
        return;
      }
      out += chunk.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = [
        truncated ? '... (output truncated)' : '',
        timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.` : `exit code: ${code}`,
      ]
        .filter(Boolean)
        .join('\n');
      resolve({ ok: !timedOut && code === 0, output: `${out.trimEnd()}\n${tail}`.trim() });
    });
  });
}

// ---- fetch_url --------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text };
}

export async function fetchUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be fetched.');
  }
  // net.fetch, not Node's fetch: Chromium's stack honours the system proxy
  // (PAC/WPAD) and the Windows certificate store, so this still works behind a
  // corporate proxy or a TLS-inspecting gateway.
  const res = await httpFetch(parsed.toString(), {
    timeoutMs: 20_000,
    retries: 1,
    headers: { 'user-agent': 'OMNI-STUDIO-Agent/1.0', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const type = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 3_000_000) throw new Error('Response too large (over 3 MB).');
  if (looksBinary(buf)) throw new Error(`Not a text response (${type || 'unknown type'}).`);
  const body = buf.toString('utf8');
  if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    const { title, text } = htmlToText(body);
    return `${title ? `Title: ${title}\n` : ''}URL: ${res.url}\n\n${text}`;
  }
  return `URL: ${res.url}\n\n${body}`;
}
