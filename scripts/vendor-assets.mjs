
import { cp, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

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

const litertRoot = path.dirname(pkgDir('@litert-lm/core', 'dist/index.js'));
await copyDir(
  path.join(litertRoot, 'wasm'),
  path.join('public', 'litertlm'),
  'litert-lm wasm',
);

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
