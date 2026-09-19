import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { applyMonacoTheme, monaco, MONACO_THEME } from '../../lib/svn/monaco';
import { monacoLanguageFromPath } from '../../lib/svn/utils';
import { IconCode } from './icons';

interface FileViewerProps {
  path: string | null;
  content: string;
  diff: string | null;
  editable: boolean;
  dirty: boolean;
  loading: boolean;
  accent: string;
  onContentChange: (value: string) => void;
  onSave: () => void;
}

export function FileViewer({
  path,
  content,
  diff,
  editable,
  dirty,
  loading,
  accent,
  onContentChange,
  onSave,
}: FileViewerProps) {
  const [mode, setMode] = useState<'source' | 'diff'>('source');
  const language = useMemo(() => monacoLanguageFromPath(path), [path]);
  // Keyboard handlers registered on mount must see the latest props.
  const saveRef = useRef({ onSave, editable });
  saveRef.current = { onSave, editable };

  // Follow the app's accent colour live.
  useEffect(() => applyMonacoTheme(accent), [accent]);

  // A file with no local changes has nothing to diff; don't strand the user on
  // an empty Diff tab when switching to one.
  useEffect(() => {
    if (!diff) setMode('source');
  }, [diff, path]);

  const handleMount: OnMount = (editor) => {
    // New vs SVN Studio: Ctrl+S saves when editing is enabled.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (saveRef.current.editable) saveRef.current.onSave();
    });
  };

  if (!path) {
    return (
      <div className="svn-empty">
        <div className="svn-empty__icon">
          <IconCode size={28} />
        </div>
        <div className="svn-empty__title">Your working copy, under control</div>
        <div className="svn-empty__subtitle">
          Select a file from Explorer, or run Update / Commit from the Source Control panel.
        </div>
      </div>
    );
  }

  const segments = path.split('/');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="svn-editor-header">
        <div className="svn-breadcrumb" title={path}>
          {segments.map((segment, i) => (
            <span key={i} className="svn-breadcrumb__segment">
              {i > 0 && <span className="svn-breadcrumb__sep">/</span>}
              {segment}
            </span>
          ))}
          {dirty && <span style={{ color: 'var(--svn-accent)', marginLeft: 8 }}>● unsaved</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <div className="svn-segmented">
            <button className={mode === 'source' ? 'svn-segmented--on' : ''} onClick={() => setMode('source')}>
              Source
            </button>
            <button
              className={mode === 'diff' ? 'svn-segmented--on' : ''}
              onClick={() => setMode('diff')}
              disabled={!diff}
              title={diff ? 'Uncommitted changes' : 'No local changes'}
            >
              Diff
            </button>
          </div>
          {editable && (
            <button className="svn-btn-primary" onClick={onSave} disabled={!dirty} title="Save (Ctrl+S)">
              Save
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <div className="svn-muted-note">Loading…</div>
        ) : mode === 'diff' && diff ? (
          <DiffView diff={diff} />
        ) : (
          <Editor
            height="100%"
            path={path}
            language={language}
            theme={MONACO_THEME}
            value={content}
            beforeMount={() => applyMonacoTheme(accent)}
            onMount={handleMount}
            onChange={(value) => onContentChange(value ?? '')}
            options={{
              readOnly: !editable,
              minimap: { enabled: true },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
              fontLigatures: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderLineHighlight: 'all',
              padding: { top: 10 },
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Unified diff, coloured by line. SVN Studio showed the raw patch as plain text
 * inside Monaco; this is the same content, readable at a glance.
 */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre
      style={{
        margin: 0,
        height: '100%',
        overflow: 'auto',
        padding: '10px 0',
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 1.6,
        userSelect: 'text',
      }}
    >
      {lines.map((line, i) => {
        const style = diffLineStyle(line);
        return (
          <div key={i} style={{ padding: '0 16px', whiteSpace: 'pre', ...style }}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function diffLineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('====')) {
    return { color: 'var(--svn-muted)', fontWeight: 600 };
  }
  if (line.startsWith('@@')) {
    return { color: 'var(--svn-link)', background: 'color-mix(in srgb, var(--svn-link) 8%, transparent)' };
  }
  if (line.startsWith('+')) {
    return { color: '#7ee2a8', background: 'rgba(63, 185, 80, 0.10)' };
  }
  if (line.startsWith('-')) {
    return { color: '#ff9b93', background: 'rgba(248, 81, 73, 0.10)' };
  }
  if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) {
    return { color: 'var(--svn-conflict)', fontWeight: 700 };
  }
  return { color: 'var(--svn-text)' };
}
