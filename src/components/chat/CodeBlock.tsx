import { useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import markdownLang from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';

// Register only the languages we care about — keeps the bundle small vs. the
// full Prism build (which bundles ~200 grammars).
const LANGS: Record<string, any> = {
  jsx,
  tsx,
  javascript,
  js: javascript,
  typescript,
  ts: typescript,
  python,
  py: python,
  bash,
  sh: bash,
  shell: bash,
  json,
  markup,
  html: markup,
  xml: markup,
  css,
  sql,
  go,
  rust,
  java,
  yaml,
  yml: yaml,
  markdown: markdownLang,
  md: markdownLang,
};
for (const [name, def] of Object.entries(LANGS)) {
  SyntaxHighlighter.registerLanguage(name, def);
}

export default function CodeBlock({
  language,
  value,
}: {
  language: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const lang = language && LANGS[language] ? language : 'text';

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/10">
      <div className="flex items-center justify-between bg-white/[0.04] px-3 py-1.5">
        <span className="mono text-[10px] text-white/45">
          {language || 'text'}
        </span>
        <button
          onClick={copy}
          className="mono flex items-center gap-1 text-[10px] text-white/45 transition hover:text-white/80"
        >
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        showLineNumbers
        wrapLongLines
        customStyle={{
          margin: 0,
          background: '#0b0d12',
          fontSize: '13px',
          padding: '14px 12px',
        }}
        lineNumberStyle={{ color: 'rgba(255,255,255,0.25)', minWidth: '2.2em' }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}
