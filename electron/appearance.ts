// Light or dark, as the main process needs to know it.
//
// Two things in the window are painted by Windows, not by CSS: the window
// controls overlay (minimise, maximise, close) and the background colour shown
// before the first frame. Both are set when the window is created, so the
// choice has to live here as well as in the renderer's localStorage — read at
// startup, updated whenever the user switches.

import { app, BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Appearance = 'dark' | 'light';

export interface WindowPalette {
  /** The strip behind the window controls. */
  color: string;
  /** The minimise / maximise / close glyphs. */
  symbolColor: string;
  /** Shown before the renderer paints its first frame. */
  background: string;
}

export const PALETTE: Record<Appearance, WindowPalette> = {
  dark: { color: '#0c0e12', symbolColor: '#8b8597', background: '#0c0e12' },
  light: { color: '#f4f2f7', symbolColor: '#5f5a6d', background: '#f4f2f7' },
};

const file = () => path.join(app.getPath('userData'), 'appearance.json');

const isAppearance = (v: unknown): v is Appearance => v === 'dark' || v === 'light';

export async function readAppearance(): Promise<Appearance> {
  try {
    const { appearance } = JSON.parse(await readFile(file(), 'utf8')) as { appearance?: unknown };
    return isAppearance(appearance) ? appearance : 'dark';
  } catch {
    return 'dark';
  }
}

export async function writeAppearance(mode: Appearance): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(file(), JSON.stringify({ appearance: mode }, null, 2), 'utf8');
}

/** Repaint the native parts of a window for the chosen appearance. */
export function applyToWindow(win: BrowserWindow, mode: Appearance): void {
  const palette = PALETTE[mode];
  win.setBackgroundColor(palette.background);
  // Only windows created with a title-bar overlay accept this.
  try {
    win.setTitleBarOverlay({ color: palette.color, symbolColor: palette.symbolColor, height: 68 });
  } catch {
    /* no overlay on this platform */
  }
}
