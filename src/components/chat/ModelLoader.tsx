import { useLlm } from '../../state/LlmContext';
import { SUGGESTED_MODELS, repoUrl } from '../../lib/models';
import { formatBytes, openExternal, shortenPath } from '../../lib/desktop';

// Shown when the GPU is available but no model is loaded yet (status: idle |
// downloading | reading | initializing | error).
//
// Desktop difference from the web build: there are no fixed model slots. The
// library holds any number of .litertlm files, so this is a picker over
// whatever the user has added, with an empty state that leads with Browse.
export default function ModelLoader() {
  const {
    status,
    error,
    progress,
    models,
    activeModelId,
    activeModel,
    rejected,
    setActiveModel,
    loadModel,
    cancel,
    dismissRejected,
  } = useLlm();

  const downloading = status === 'downloading';
  const busy = downloading || status === 'reading' || status === 'initializing';
  const pct = Math.round((progress?.ratio ?? 0) * 100);
  const empty = models.length === 0;

  return (
    <div className="glass mx-auto w-full max-w-xl rounded-[var(--radius-panel)] p-8 text-center">
      <div className="neon-glow mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-[var(--color-neon)]/20 text-2xl text-[var(--color-neon)]">
        ✦
      </div>
      <h2 className="text-xl font-semibold text-white">
        {empty ? 'Add a model' : 'Choose a model'}
      </h2>
      <p className="mt-1 text-sm text-white/50">
        {empty
          ? 'Any LiteRT-LM .litertlm file — it runs entirely on this machine'
          : `${models.length} model${models.length === 1 ? '' : 's'} in your library`}
      </p>

      {busy ? (
        <div className="mt-6">
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--color-neon)] transition-[width]"
              style={{ width: status === 'initializing' ? '100%' : `${pct}%` }}
            />
          </div>
          <p className="mono mt-3 text-[11px] text-white/50">
            {status === 'initializing'
              ? 'Initializing WebGPU engine…'
              : status === 'reading'
                ? `Reading model from disk · ${pct}%`
                : progress?.totalBytes
                  ? `Downloading ${pct}% · ${formatBytes(
                      progress.receivedBytes,
                    )} / ${formatBytes(progress.totalBytes)}`
                  : `Downloading ${formatBytes(progress?.receivedBytes ?? 0)}…`}
          </p>
          {downloading && (
            <button
              onClick={cancel}
              className="mono mt-3 text-[10px] text-white/40 underline transition hover:text-white/70"
            >
              cancel download
            </button>
          )}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {/* The library. Clicking a row selects it; the button below loads it. */}
          {!empty && (
            <div className="max-h-64 space-y-1.5 overflow-y-auto text-left">
              {models.map((m) => {
                const active = m.id === activeModelId;
                return (
                  <button
                    key={m.id}
                    onClick={() => setActiveModel(m.id)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                      active
                        ? 'neon-glow border-[var(--color-neon)]/60 bg-[var(--color-neon)]/10'
                        : 'border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        active ? 'bg-[var(--color-neon)]' : 'bg-white/20'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">
                        {m.label}
                      </span>
                      <span
                        className="mono block truncate text-[10px] text-white/35"
                        title={m.path}
                      >
                        {shortenPath(m.path)}
                      </span>
                    </span>
                    <span className="mono shrink-0 text-[10px] text-white/40">
                      {formatBytes(m.size)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {activeModel && (
            <button
              onClick={() => loadModel({ type: 'library' })}
              className="neon-glow rounded-xl bg-[var(--color-neon)] px-4 py-3 text-sm font-semibold text-black transition hover:brightness-110"
            >
              Load {activeModel.label}
            </button>
          )}

          <button
            onClick={() => loadModel({ type: 'add' })}
            className={`rounded-xl px-4 py-3 text-sm font-semibold transition ${
              empty
                ? 'neon-glow bg-[var(--color-neon)] text-black hover:brightness-110'
                : 'glass text-white hover:bg-white/10'
            }`}
          >
            {empty ? 'Browse for a .litertlm file…' : '＋ Add another model…'}
          </button>

          {/* Files the picker refused, with the reason. */}
          {rejected.length > 0 && (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-left">
              {rejected.map((r) => (
                <p key={r.name} className="text-[11px] leading-relaxed text-amber-200/90">
                  <span className="mono">{r.name}</span> — {r.reason}
                </p>
              ))}
              <button
                onClick={dismissRejected}
                className="mono mt-1 text-[10px] text-white/40 underline hover:text-white/70"
              >
                dismiss
              </button>
            </div>
          )}

          {empty && (
            <div className="mt-1 border-t border-white/5 pt-3">
              <p className="mono mb-2 text-[10px] text-white/30">
                or download one
              </p>
              <div className="flex flex-col gap-1.5">
                {SUGGESTED_MODELS.map((s) => (
                  <div key={s.file} className="flex items-center gap-2">
                    <button
                      onClick={() => loadModel({ type: 'download', suggestion: s })}
                      className="mono flex-1 rounded-lg border border-white/10 px-3 py-2 text-left text-[11px] text-white/60 transition hover:bg-white/5 hover:text-white"
                    >
                      {s.label}{' '}
                      <span className="text-white/30">· ~{s.approxSizeGB} GB</span>
                    </button>
                    <button
                      onClick={() => openExternal(repoUrl(s))}
                      title="Open the model page"
                      className="mono shrink-0 rounded-lg px-2 py-2 text-[10px] text-[var(--color-teal)] underline"
                    >
                      repo ↗
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-white/35">
                Gemma is gated, so a direct download returns a login page. Accept
                the license on the repo page, download the{' '}
                <span className="mono">.litertlm</span> with the file’s ↓ button,
                then browse to it above — it stays where you put it, nothing is
                copied.
              </p>
            </div>
          )}
        </div>
      )}

      {status === 'error' && error && (
        <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
