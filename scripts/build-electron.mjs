
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const OUT = 'dist-electron';

await rm(OUT, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
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
