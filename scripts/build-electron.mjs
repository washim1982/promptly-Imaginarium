// Bundle the main process and preload to CommonJS.
//
// CJS on purpose: a sandboxed preload script cannot be an ES module, and
// keeping main.cjs in the same format avoids the ESM-in-Electron caveats
// around top-level await and `app.whenReady()` ordering.

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const OUT = 'dist-electron';

await rm(OUT, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Electron and Node built-ins are provided by the runtime.
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: `${OUT}/main.cjs` }),
  build({
    ...common,
    entryPoints: ['electron/preload.ts'],
    outfile: `${OUT}/preload.cjs`,
  }),
]);
