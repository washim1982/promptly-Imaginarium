// Copy runtime assets that the web build streamed from a CDN into public/, so
// the desktop app is genuinely offline and satisfies its own CSP.
//
//   @litert-lm/core/wasm  -> public/litertlm/   (~19 MB, the inference runtime)
//   tesseract.js worker   -> public/tesseract/  (OCR for scanned PDFs)
//   tesseract.js-core     -> public/tesseract/core/
//
// Runs on postinstall and again before every build, so a fresh clone Just Works.

import { cp, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Resolve a package's install directory from one of its published files. */
function pkgDir(pkg, probe) {
  return path.dirname(require.resolve(`${pkg}/${probe}`));
}

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function copyDir(from, to, label) {
  if (!(await exists(from))) {
    console.warn(`[vendor] skipped ${label}: ${from} not found`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[vendor] ${label} -> ${path.relative(process.cwd(), to)}`);
}

// 1. LiteRT-LM wasm runtime. The library otherwise defaults to
//    https://cdn.jsdelivr.net/npm/@litert-lm/core@<ver>/wasm — see
//    src/lib/engine.ts, which points it at this local copy instead.
const litertRoot = path.dirname(pkgDir('@litert-lm/core', 'dist/index.js'));
await copyDir(
  path.join(litertRoot, 'wasm'),
  path.join('public', 'litertlm'),
  'litert-lm wasm',
);

// 2. Tesseract worker + wasm core (the eng.traineddata.gz language file is
//    already committed under public/tesseract/).
const tessDist = pkgDir('tesseract.js', 'dist/worker.min.js');
await copyDir(
  path.join(tessDist, 'worker.min.js'),
  path.join('public', 'tesseract', 'worker.min.js'),
  'tesseract worker',
);

let tessCore = null;
try {
  tessCore = path.dirname(require.resolve('tesseract.js-core/package.json'));
} catch {
  console.warn('[vendor] tesseract.js-core not resolvable; OCR will not work offline');
}
if (tessCore) {
  await copyDir(tessCore, path.join('public', 'tesseract', 'core'), 'tesseract core');
}
