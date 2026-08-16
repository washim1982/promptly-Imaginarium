// Dev orchestration: Vite dev server (renderer, with HMR) + esbuild watch
// (main/preload) + Electron pointed at the dev server.
//
// Editing anything under src/ hot-reloads in place. Editing electron/ rebuilds
// and restarts Electron automatically.

import { spawn } from 'node:child_process';
import { context } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';

const OUT = 'dist-electron';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('Vite did not report a local dev server URL.');
server.printUrls();

let child = null;
let restarting = false;

function startElectron() {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
  });
  child.on('exit', (code) => {
    child = null;
    if (restarting) return; // we killed it on purpose
    void shutdown(code ?? 0);
  });
}

async function shutdown(code) {
  restarting = true;
  child?.kill();
  await ctx.dispose().catch(() => {});
  await server.close().catch(() => {});
  process.exit(code);
}

// Rebuild main/preload on change, then bounce Electron.
const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      if (!child) {
        startElectron();
        return;
      }
      restarting = true;
      child.kill();
      await new Promise((r) => setTimeout(r, 250));
      restarting = false;
      startElectron();
    });
  },
};

const ctx = await context({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  plugins: [restartPlugin],
});

await ctx.watch();

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
