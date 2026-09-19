// Monaco for the SVN editor, bundled locally.
//
// @monaco-editor/react loads Monaco from cdn.jsdelivr.net by default. That breaks
// here twice over: the app is offline-capable and its CSP forbids remote scripts.
// So Monaco comes from node_modules, and its language workers are bundled as
// same-origin chunks via Vite's ?worker imports (COEP-safe under app://).

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

export const MONACO_THEME = 'imaginarium';

/** Monaco wants #rrggbb; the accent may be a 3-digit hex from the custom picker. */
function toHex6(color: string): string {
  const c = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#ff3da6';
}

/**
 * (Re)define the editor theme from the app's current accent, so the cursor,
 * selection and highlights follow whichever glow colour is picked in Settings.
 */
export function applyMonacoTheme(accent: string): void {
  const neon = toHex6(accent);
  monaco.editor.defineTheme(MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b6478', fontStyle: 'italic' },
      { token: 'keyword', foreground: neon.slice(1) },
      { token: 'string', foreground: '7dd3c0' },
      { token: 'number', foreground: 'f0b27a' },
      { token: 'type', foreground: '1fb6c9' },
    ],
    colors: {
      'editor.background': '#0c0e12', // --color-ink
      'editor.foreground': '#ece9f1',
      'editorLineNumber.foreground': '#4a4556',
      'editorLineNumber.activeForeground': neon,
      'editorCursor.foreground': neon,
      'editor.selectionBackground': `${neon}40`,
      'editor.inactiveSelectionBackground': `${neon}22`,
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#ffffff0d',
      'editorIndentGuide.activeBackground1': `${neon}55`,
      'editorWidget.background': '#15171c',
      'editorWidget.border': '#ffffff14',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff20',
      'minimap.background': '#0c0e12',
      'focusBorder': `${neon}80`,
    },
  });
}

export { monaco };
