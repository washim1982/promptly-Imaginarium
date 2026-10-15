// The spreadsheet editor: a grid you can type into, and a save that writes
// back through ExcelJS in the main process.
//
// Edits are kept as a list of cell changes rather than a rebuilt sheet, so
// saving mutates the original workbook and leaves everything it doesn't touch
// — styles, formulas elsewhere, other sheets, charts — exactly as it was.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save, Table2 } from 'lucide-react';
import { cellRef, columnLabel, officeApi, type CellEdit, type WorkbookData } from '../../lib/office/api';
import { cleanError } from '../../lib/desktop';

interface Props {
  file: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onNotify: (type: 'success' | 'error', message: string) => void;
}

const key = (sheet: string, row: number, column: number) => `${sheet}!${row}:${column}`;

export default function SheetEditor({ file, onDirtyChange, onSaved, onNotify }: Props) {
  const [book, setBook] = useState<WorkbookData | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Map<string, CellEdit>>(new Map());
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const [editing, setEditing] = useState<{ row: number; column: number; value: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setEdits(new Map());
    setActive(0);
    officeApi
      .readWorkbook(file)
      .then((data) => !cancelled && setBook(data))
      .catch((err) => !cancelled && setError(cleanError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => onDirtyChange(edits.size > 0), [edits, onDirtyChange]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const sheet = book?.sheets[active];

  /** The grid shows the edited value where there is one, else the stored text. */
  const valueAt = useMemo(() => {
    return (row: number, column: number): { text: string; edited: boolean; formula?: string; numeric?: boolean } => {
      if (!sheet) return { text: '', edited: false };
      const pending = edits.get(key(sheet.name, row, column));
      if (pending) return { text: pending.value, edited: true };
      const cell = sheet.rows[row - 1]?.[column - 1];
      return { text: cell?.text ?? '', edited: false, formula: cell?.formula, numeric: cell?.numeric };
    };
  }, [sheet, edits]);

  const commit = (row: number, column: number, value: string) => {
    if (!sheet) return;
    const original = sheet.rows[row - 1]?.[column - 1];
    const was = original?.formula ? `=${original.formula}` : (original?.text ?? '');
    setEdits((current) => {
      const next = new Map(current);
      const k = key(sheet.name, row, column);
      // Typing a value back to what it was is not an edit.
      if (value === was) next.delete(k);
      else next.set(k, { sheet: sheet.name, row, column, value });
      return next;
    });
    setEditing(null);
  };

  const startEditing = (row: number, column: number) => {
    const v = valueAt(row, column);
    setEditing({ row, column, value: v.formula && !v.edited ? `=${v.formula}` : v.text });
  };

  const save = async () => {
    if (!edits.size) return;
    setSaving(true);
    try {
      const { applied } = await officeApi.saveWorkbook(file, [...edits.values()]);
      setEdits(new Map());
      onSaved();
      onNotify('success', `Saved ${applied} cell${applied === 1 ? '' : 's'} to ${file.split('/').pop()}.`);
      setBook(await officeApi.readWorkbook(file));
    } catch (err) {
      onNotify('error', cleanError(err));
    } finally {
      setSaving(false);
    }
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!sheet || !selected || editing) return;
    const { row, column } = selected;
    const move = (dr: number, dc: number) =>
      setSelected({
        row: Math.min(Math.max(1, row + dr), Math.max(sheet.rowCount, 1)),
        column: Math.min(Math.max(1, column + dc), Math.max(sheet.columnCount, 1)),
      });
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); move(1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, 0); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(0, -1); }
    else if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); move(0, 1); }
    else if (e.key === 'F2') { e.preventDefault(); startEditing(row, column); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commit(row, column, ''); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setEditing({ row, column, value: e.key });
    } else if ((e.key === 's' || e.key === 'S') && e.ctrlKey) {
      e.preventDefault();
      void save();
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-white/50">
        <Loader2 className="animate-spin" size={18} /> Opening the workbook…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-10">
        <p className="max-w-lg text-center text-sm text-red-300">{error}</p>
      </div>
    );
  }
  if (!sheet) return null;

  const current = selected ? valueAt(selected.row, selected.column) : null;

  return (
    <div className="flex h-full flex-col">
      {/* formula bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <span className="mono w-16 shrink-0 text-[11px] text-white/40">
          {selected ? cellRef(selected.row, selected.column) : '—'}
        </span>
        <span className="mono flex-1 truncate text-[12px] text-white/70">
          {current?.formula ? `=${current.formula}` : (current?.text ?? '')}
        </span>
        <button
          onClick={() => void save()}
          disabled={!edits.size || saving}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-neon)]/20 px-3 py-1.5 text-[12px] text-[var(--color-neon)] transition hover:bg-[var(--color-neon)]/30 disabled:opacity-35"
        >
          {saving ? <Loader2 className="animate-spin" size={13} /> : <Save size={13} />}
          {edits.size ? `Save ${edits.size}` : 'Saved'}
        </button>
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={onGridKeyDown}>
        <table className="ms-grid">
          <thead>
            <tr>
              <th className="ms-corner" />
              {Array.from({ length: sheet.columnCount }, (_, i) => (
                <th key={i} style={{ minWidth: Math.max(60, sheet.columnWidths[i] ?? 90) }}>
                  {columnLabel(i + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sheet.rowCount }, (_, r) => {
              const row = r + 1;
              return (
                <tr key={row}>
                  <th className="ms-rownum">{row}</th>
                  {Array.from({ length: sheet.columnCount }, (_, c) => {
                    const column = c + 1;
                    const v = valueAt(row, column);
                    const isSelected = selected?.row === row && selected?.column === column;
                    const isEditing = editing?.row === row && editing?.column === column;
                    return (
                      <td
                        key={column}
                        className={`${isSelected ? 'ms-selected' : ''} ${v.edited ? 'ms-edited' : ''} ${v.numeric ? 'ms-numeric' : ''}`}
                        onClick={() => setSelected({ row, column })}
                        onDoubleClick={() => startEditing(row, column)}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            value={editing.value}
                            onChange={(e) => setEditing({ row, column, value: e.target.value })}
                            onBlur={() => commit(row, column, editing.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commit(row, column, editing.value); setSelected({ row: row + 1, column }); }
                              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                              else if (e.key === 'Tab') { e.preventDefault(); commit(row, column, editing.value); setSelected({ row, column: column + 1 }); }
                            }}
                            className="ms-input"
                          />
                        ) : (
                          v.text
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {sheet.truncated && (
          <p className="mono px-3 py-2 text-[10px] text-amber-300/70">
            Showing the first {sheet.rowCount} rows and {sheet.columnCount} columns of a larger sheet. Edits outside
            this window are not possible here.
          </p>
        )}
      </div>

      {/* sheet tabs */}
      {book && book.sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 border-t border-white/5 px-2 py-1.5">
          <Table2 size={13} className="mr-1 text-white/30" />
          {book.sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              className={`rounded-md px-2.5 py-1 text-[12px] transition ${
                i === active ? 'bg-[var(--color-neon)]/20 text-[var(--color-neon)]' : 'text-white/50 hover:text-white'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
