// Settings → Web search: paste a Tavily API key, test it, and choose whether
// plain chat may search on its own.
//
// Mirrors the Auth0 setup dialog: the secret goes straight to the main process,
// comes back only masked, and the panel never keeps it in state after a save.

import { useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { useLlm } from '../state/LlmContext';
import { cleanError, openExternal } from '../lib/desktop';
import { describeProvider, hasSearchBridge, searchApi, type SearchStatus } from '../lib/websearch';

const inputClass =
  'w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[12.5px] text-white placeholder:text-white/30 focus:border-[var(--color-neon)]/50 focus:outline-none';

export default function WebSearchSettings() {
  const { autoWebSearch, setAutoWebSearch } = useLlm();
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [key, setKey] = useState('');
  const [keenableKey, setKeenableKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    if (!hasSearchBridge()) return;
    void searchApi.status().then(setStatus).catch(err => setError(cleanError(err)));
  }, []);

  if (!hasSearchBridge()) return null;

  const run = async (kind: 'save' | 'test' | 'clear', fn: () => Promise<string>) => {
    setBusy(kind);
    setError('');
    setOk('');
    try {
      setOk(await fn());
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      setStatus(await searchApi.saveKey(key));
      setKey(''); // the panel does not keep the secret around
      return 'Key saved.';
    });

  const test = () =>
    run('test', async () => {
      // Test what is typed, or the key already stored if the box is empty.
      if (key.trim()) {
        await searchApi.verifyKey(key);
        return 'That key works.';
      }
      await searchApi.verifyKey('', 'tavily');
      return 'Tavily key works.';
    });

  const clear = () =>
    run('clear', async () => {
      setStatus(await searchApi.clearKey());
      setKey('');
      return 'Key removed.';
    });

  const configured = Boolean(status?.source);

  return (
    <section className="mb-7">
      <h3 className="mono mb-3 flex items-center gap-2 text-[11px] text-[var(--color-neon)]">
        Web search
      </h3>

      <div className="mb-3 flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] text-white">{describeProvider(status)}</div>
          <div className="mono text-[10px] text-white/35">
            {configured ? 'Tavily is ready if Keenable fails' : 'Keenable works without a key; used by chat, agents and Planning'}
          </div>
        </div>
        {configured && (
          <span className="mono flex items-center gap-1 text-[10px] text-[var(--color-neon)]">
            <Check className="h-3 w-3" /> ready
          </span>
        )}
      </div>

      <div className="mb-5 rounded-lg border border-white/10 bg-black/20 p-3">
        <label className="mono mb-1 block text-[10px] text-white/60" htmlFor="keenable-key">Keenable API key (default search)</label>
        <p className="mb-2 text-[11px] text-white/40">
          {status?.keenableSource ? `Configured: ${status.keenableMasked}` : 'Optional. Search works without a key; add yours for authenticated access.'}
        </p>
        {status?.keenableSource === 'env' ? <p className="text-[11px] text-white/40">Using KEENABLE_API_KEY from the environment. Unset it to manage the key here.</p> : <>
          <input id="keenable-key" type="password" autoComplete="off" spellCheck={false}
            disabled={busy !== null || !status} className={inputClass} value={keenableKey} placeholder="Paste your Keenable API key"
            onChange={e => setKeenableKey(e.target.value)} />
          <button type="button" disabled={!keenableKey.trim() || busy !== null || !status}
            className="mt-2 rounded-lg bg-[var(--color-neon)]/20 px-3 py-1.5 text-[12px] text-[var(--color-neon)] disabled:opacity-40"
            onClick={() => void run('save', async () => {
              setStatus(await searchApi.saveKey(keenableKey, 'keenable')); setKeenableKey(''); return 'Keenable key saved.';
            })}>Save Keenable key</button>
          {status?.keenableSource === 'saved' && <button type="button" disabled={busy !== null}
            className="ml-2 rounded-lg px-3 py-1.5 text-[12px] text-white/60 disabled:opacity-40"
            onClick={() => void run('clear', async () => {
              setStatus(await searchApi.clearKey('keenable')); setKeenableKey(''); return 'Keenable key removed. Search now uses keyless access.';
            })}>Remove</button>}
        </>}
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy !== null || (!keenableKey.trim() && !status?.keenableSource)}
            className="glass rounded-lg px-3 py-1.5 text-[12px] text-white/70 disabled:opacity-40"
            onClick={() => void run('test', async () => {
              await searchApi.verifyKey(keenableKey, 'keenable'); return 'Keenable key works.';
            })}>Test Keenable key</button>
          <button type="button" onClick={() => openExternal('https://app.keenable.ai/')}
            className="ml-auto flex items-center gap-1 text-[11px] text-white/50">Get a key <ExternalLink className="h-3 w-3" /></button>
        </div>
      </div>

      {status?.source !== 'env' && (
        <>
          <label className="mono mb-1 block text-[10px] text-white/40" htmlFor="tavily-key">
            Tavily fallback API key
          </label>
          <input
            id="tavily-key"
            type="password"
            value={key}
            spellCheck={false}
            autoComplete="off"
            placeholder={configured ? 'Paste a new key to replace the saved one' : 'tvly-…'}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) void save();
            }}
            className={inputClass}
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!key.trim() || busy !== null}
              onClick={() => void save()}
              className="rounded-lg bg-[var(--color-neon)]/20 px-3 py-1.5 text-[12px] text-[var(--color-neon)] transition hover:bg-[var(--color-neon)]/30 disabled:opacity-40"
            >
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save key'}
            </button>
            <button
              type="button"
              disabled={busy !== null || (!key.trim() && !status?.source)}
              onClick={() => void test()}
              className="glass rounded-lg px-3 py-1.5 text-[12px] text-white/70 transition hover:text-white disabled:opacity-40"
            >
              {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Test'}
            </button>
            {configured && status?.source === 'saved' && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void clear()}
                className="glass flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-white/50 transition hover:text-white disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
            <button
              type="button"
              onClick={() => openExternal('https://app.tavily.com/home')}
              className="mono ml-auto flex items-center gap-1 text-[10px] text-white/40 transition hover:text-white/70"
            >
              Get a key <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </>
      )}

      {status?.source === 'env' && (
        <p className="text-[10px] text-white/30">
          The key comes from the TAVILY_API_KEY environment variable. Unset it to manage the key here instead.
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
      {ok && <p className="mt-2 text-[11px] text-[var(--color-neon)]">{ok}</p>}
      {status && !status.canPersist && (
        <p className="mt-2 text-[10px] text-amber-300/70">
          Windows encrypted storage is unavailable, so a key saved here lasts only until the app closes.
        </p>
      )}

      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
        <input
          type="checkbox"
          checked={autoWebSearch}
          onChange={(e) => setAutoWebSearch(e.target.checked)}
          className="mt-0.5 accent-[var(--color-neon)]"
        />
        <span className="min-w-0">
          <span className="block text-[12.5px] text-white">Search automatically when a question needs live data</span>
          <span className="mono block text-[10px] leading-relaxed text-white/35">
            Questions about today, the latest release, a current price and the like are answered from the web, with
            sources shown under the reply. Say “don’t search” to skip it, or “search the web for…” to force it.
            Messages carrying an email, a Drive file or a workspace file are never searched automatically.
          </span>
        </span>
      </label>
    </section>
  );
}
