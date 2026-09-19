import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlatEntry } from '../../lib/svn/utils';
import { IconChevronRight, IconFile, IconSearch } from './icons';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  files: FlatEntry[];
  commands: PaletteCommand[];
  onSelectFile: (path: string) => void;
}

type ResultItem =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'command'; id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ open, onClose, files, commands, onSelectFile }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const results = useMemo<ResultItem[]>(() => {
    const q = query.trim().toLowerCase();
    const commandResults: ResultItem[] = commands
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ kind: 'command', id: c.id, label: c.label, hint: c.hint, run: c.run }));
    const fileResults: ResultItem[] = files
      .filter((f) => !f.isDirectory && (!q || f.path.toLowerCase().includes(q)))
      .slice(0, 40)
      .map((f) => ({ kind: 'file', path: f.path, name: f.name }));
    return [...commandResults, ...fileResults];
  }, [query, files, commands]);

  useEffect(() => setActiveIndex(0), [results.length]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function activate(item: ResultItem) {
    if (item.kind === 'file') onSelectFile(item.path);
    else item.run();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      activate(results[activeIndex]);
    }
  }

  if (!open) return null;

  return (
    <div className="svn-palette-overlay" onClick={onClose}>
      <div className="svn-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="svn-palette__input-row">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            className="svn-palette__input"
            placeholder="Search files or commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="svn-kbd">Esc</kbd>
        </div>
        <div className="svn-palette__results" ref={listRef}>
          {results.length === 0 && <div className="svn-palette__empty">No matches.</div>}
          {results.map((item, i) => (
            <button
              key={item.kind === 'file' ? `f:${item.path}` : `c:${item.id}`}
              className={`svn-palette__item ${i === activeIndex ? 'svn-palette__item--active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => activate(item)}
            >
              <span className="svn-palette__item-icon">
                {item.kind === 'file' ? <IconFile size={14} /> : <IconChevronRight size={14} />}
              </span>
              <span>{item.kind === 'file' ? item.name : item.label}</span>
              <span className="svn-palette__item-hint">{item.kind === 'file' ? item.path : item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
