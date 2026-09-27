
const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BUILD_DIR = path.join(__dirname, '..', 'build');

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

const SIMPLIFY_BELOW = 32;

const RASTERIZE = `async (svg, size) => {
  // Rewrite the intrinsic size so Chromium rasterizes at the target
  // resolution instead of resampling a 256px bitmap.
  let sized = svg
    .replace(/width="\\d+"/, 'width="' + size + '"')
    .replace(/height="\\d+"/, 'height="' + size + '"');

  if (size < ${SIMPLIFY_BELOW}) {
    sized = sized.replace(/<g id="spark">[\\s\\S]*?<\\/g>/, '');
  }

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('SVG failed to decode at ' + size + 'px'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
  });

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size); // transparent outside the rounded corners
  ctx.drawImage(img, 0, 0, size, size);
  return canvas.toDataURL('image/png').split(',')[1];
}`;

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const svg = await readFile(path.join(BUILD_DIR, 'icon.svg'), 'utf8');

    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true },
    });
    await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">');

    const images = [];
    for (const size of SIZES) {
      const base64 = await win.webContents.executeJavaScript(
        `(${RASTERIZE})(${JSON.stringify(svg)}, ${size})`,
      );
      images.push({ size, data: Buffer.from(base64, 'base64') });
      console.log(`[icon] ${size}×${size} — ${images.at(-1).data.length} bytes`);
    }

    await writeFile(path.join(BUILD_DIR, 'icon.ico'), buildIco(images));
    await writeFile(
      path.join(BUILD_DIR, 'icon.png'),
      images.find((i) => i.size === 256).data,
    );

    console.log(`[icon] wrote build/icon.ico (${images.length} sizes) + icon.png`);
    app.exit(0);
  })
  .catch((err) => {
    console.error('[icon] failed:', err);
    app.exit(1);
  });
