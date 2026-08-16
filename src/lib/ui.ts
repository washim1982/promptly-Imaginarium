// UI-only preferences (not part of the model/engine config).

export type ChatWidth = 'narrow' | 'standard' | 'wide';

export const CHAT_WIDTHS: {
  id: ChatWidth;
  label: string;
  sub: string;
}[] = [
  { id: 'narrow', label: 'Narrow', sub: 'Compact' },
  { id: 'standard', label: 'Standard', sub: 'Default' },
  { id: 'wide', label: 'Wide', sub: 'Expanded' },
];

// Tailwind max-width class applied to the chat conversation + composer.
export const CHAT_WIDTH_CLASS: Record<ChatWidth, string> = {
  narrow: 'max-w-xl',
  standard: 'max-w-3xl',
  wide: 'max-w-5xl',
};
