// In-app replacement for window.prompt().
//
// Electron does not implement prompt() — it throws "prompt() is not supported."
// The web build used it for renaming chats, and SVN Studio used it for new
// file / new folder / rename, so all of those silently failed on the desktop.
// usePrompt() gives the same "ask for a string" call, as a themed dialog.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error message to block submission, or null if the value is fine. */
  validate?: (value: string) => string | null;
}

type Ask = (options: PromptOptions) => Promise<string | null>;

const PromptContext = createContext<Ask | null>(null);

interface Pending extends PromptOptions {
  resolve: (value: string | null) => void;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback<Ask>(
    (options) =>
      new Promise((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  const settle = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };

  return (
    <PromptContext.Provider value={ask}>
      {children}
      {pending && <PromptModal options={pending} onSettle={settle} />}
    </PromptContext.Provider>
  );
}

export function usePrompt(): Ask {
  const ask = useContext(PromptContext);
  if (!ask) throw new Error('usePrompt must be used within <PromptProvider>');
  return ask;
}

function PromptModal({
  options,
  onSettle,
}: {
  options: PromptOptions;
  onSettle: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const error = options.validate?.(value) ?? null;
  const blank = !value.trim();

  // Select the name but not the extension, like Explorer's rename.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, []);

  function submit() {
    if (blank || error) return;
    onSettle(value.trim());
  }

  return (
    <div
      className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      onMouseDown={() => onSettle(null)}
    >
      <div
        className="glass w-full max-w-md rounded-[var(--radius-panel)] p-6"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={options.title}
      >
        <h2 className="text-lg font-semibold text-white">{options.title}</h2>
        {options.label && <p className="mono mt-4 text-[10px] text-white/40">{options.label}</p>}
        <input
          ref={inputRef}
          value={value}
          placeholder={options.placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onSettle(null);
          }}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-[var(--color-neon)]/50 focus:outline-none"
        />
        <p className="mt-2 min-h-4 text-[11px] text-red-300">{!blank && error ? error : ''}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() => onSettle(null)}
            className="rounded-lg px-4 py-2 text-sm text-white/60 transition hover:bg-white/5 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={blank || Boolean(error)}
            className="neon-glow rounded-lg bg-[var(--color-neon)] px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
          >
            {options.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
