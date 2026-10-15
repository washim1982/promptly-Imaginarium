
export interface Theme {
  id: string;
  label: string;
  color: string;
}

export const THEMES: Theme[] = [
  { id: 'amethyst', label: 'Amethyst', color: '#a855f7' },
  { id: 'electric', label: 'Electric', color: '#06b6d4' },
  { id: 'neon', label: 'Neon', color: '#ff3da6' },
  { id: 'emerald', label: 'Emerald', color: '#10b981' },
  { id: 'warmer', label: 'Warmer', color: '#f97316' },
  { id: 'deep', label: 'Deep', color: '#3b82f6' },
  { id: 'cosmic', label: 'Cosmic', color: '#f59e0b' },
  { id: 'silver', label: 'Silver', color: '#94a3b8' },
];

export const DEFAULT_THEME_ID = 'neon';

export function isValidHex(v: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

export function normalizeHex(v: string): string {
  const t = v.trim();
  return t.startsWith('#') ? t : `#${t}`;
}

export function resolveAccent(
  themeId: string,
  customGlow: string | null,
): string {
  if (customGlow && isValidHex(customGlow)) return normalizeHex(customGlow);
  return THEMES.find((t) => t.id === themeId)?.color ?? '#ff3da6';
}

// ---- light / dark ---------------------------------------------------------------

export type Appearance = 'dark' | 'light';

export const APPEARANCE_KEY = 'imaginarium.appearance';
export const DEFAULT_APPEARANCE: Appearance = 'dark';

export const isAppearance = (v: unknown): v is Appearance => v === 'dark' || v === 'light';

export function readAppearance(): Appearance {
  try {
    const saved = window.localStorage.getItem(APPEARANCE_KEY);
    return isAppearance(saved) ? saved : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * Light mode is a `data-theme` attribute on <html>; the stylesheets redefine
 * their tokens under it. Dark is the default, so the attribute is removed
 * rather than set to "dark" — one less thing to keep in sync.
 */
export function applyAppearance(mode: Appearance): void {
  const root = document.documentElement;
  if (mode === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

/**
 * The accents are tuned for glowing on near-black. On paper the bright ones
 * are too pale to read as text, so they are deepened — enough for contrast,
 * not so much that the colour stops being recognisable.
 */
export function accentFor(accent: string, mode: Appearance): string {
  if (mode === 'dark') return accent;
  const hex = normalizeHex(accent);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Perceived brightness (ITU-R BT.601). Anything pale gets pulled down.
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  if (brightness < 110) return hex;
  const factor = Math.max(0.5, 110 / brightness);
  const channel = (v: number) => Math.round(v * factor).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
