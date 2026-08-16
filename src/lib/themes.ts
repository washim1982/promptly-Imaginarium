// Visual theme = the app's accent / glow color. Applied by overriding the
// --color-neon CSS variable (and deriving --color-neon-soft from it), so every
// neon-glow, accent button, focus ring, and ambient gradient follows.

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

// Resolve the effective accent color from a preset id + optional custom hex.
export function resolveAccent(
  themeId: string,
  customGlow: string | null,
): string {
  if (customGlow && isValidHex(customGlow)) return normalizeHex(customGlow);
  return THEMES.find((t) => t.id === themeId)?.color ?? '#ff3da6';
}
