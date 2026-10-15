// Read-only Monaco for the File Viewer.
//
// Lazy-loaded so the editor (and its workers) only arrive when a code file is
// actually opened — and it shares the chunk SVN Studio already pulls in.

import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { applyMonacoTheme, MONACO_THEME } from '../../lib/svn/monaco';
import { monacoLanguageFromPath } from '../../lib/svn/utils';

export default function MonacoViewer({
  path,
  text,
  accent,
  appearance,
}: {
  path: string;
  text: string;
  accent: string;
  appearance: 'dark' | 'light';
}) {
  useEffect(() => {
    applyMonacoTheme(accent, appearance);
  }, [accent, appearance]);

  return (
    <Editor
      height="100%"
      theme={MONACO_THEME}
      // Monaco keys its model off the path, so switching files swaps the model
      // rather than re-typing into the old one.
      path={path}
      language={monacoLanguageFromPath(path.replace(/\\/g, '/'))}
      value={text}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        wordWrap: 'off',
        folding: true,
        smoothScrolling: true,
        automaticLayout: true,
      }}
    />
  );
}
