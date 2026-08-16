// Rasterize build/icon.svg into build/icon.ico (+ icon.png) using Electron's
// own renderer — the one dependency this project already has, so there's no
// ImageMagick/sharp/rsvg step and the result matches what Chromium draws.
//
//   npm run icon
//
// Each size is rasterized natively (the SVG's width/height are rewritten per
// size) rather than downscaled from 256px, so the 16px entry stays crisp.
//
// CommonJS on purpose: Electron's entry point, like electron/main.ts.

const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

// Windows uses 16/32/48 in Explorer and the taskbar, 256 for the large tile.
// The rest fill in the intermediate DPI scalings.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BUILD_DIR = path.join(__dirname, '..', 'build');

/**
 * Assemble a multi-resolution .ico.
 *
 * The format is a 6-byte header, one 16-byte directory entry per image, then
 * the image payloads. Entries hold PNG data rather than BMP — supported since
 * Vista, and the only sane option for the 256px entry.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    // 256 is encoded as 0 — the field is a single byte.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0); // width
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size (0 = truecolour)
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

// Below this, the accent spark sits on top of the star's upper-right arm and
// costs legibility instead of adding detail — so the mark is simplified to just
// the star, the way icon sets normally shed detail at small sizes.
const SIMPLIFY_BELOW = 32;

/** Draw the SVG onto a canvas at `size` and return the PNG bytes. */
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

// Keep rasterization off the GPU so the output is identical on any machine.
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
    // Standalone 256px PNG: handy for docs, and what a Linux build would want.
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
