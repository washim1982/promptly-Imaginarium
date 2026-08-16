import { useLlm } from '../../state/LlmContext';
import { MODELS } from '../../lib/models';
import { formatBytes, openExternal, shortenPath } from '../../lib/desktop';

function gb(n: number) {
  return `${n.toFixed(1)} GB`;
}

// Shown when the GPU is available but no model is loaded yet (status: idle |
// downloading | reading | initializing | error).
//
// Desktop difference from the web build: there is no "import into OPFS" step.
// You point the app at a .litertlm file once and it is streamed off disk from
// then on, so the primary action is a native Browse dialog and the secondary
// state is "this exact file is linked", shown with its real path.
export default function ModelLoader() {
  const { status, error, progress, activeModelId, linked, loadModel, cancel } =
    useLlm();
  const spec = MODELS[activeModelId];

  const downloading = status === 'downloading';
  const busy = downloading || status === 'reading' || status === 'initializing';
  const pct = Math.round((progress?.ratio ?? 0) * 100);

  // The picker registers whatever file you choose under the *selected* model
  // slot, so it's easy to end up with E4B weights loaded while the UI says E2B.
  // Nothing breaks — the engine reads the real file — but the label would lie.
  const mismatch = linked != null && linked.name !== spec.file;

  return (
    <div className="glass mx-auto w-full max-w-xl rounded-[var(--radius-panel)] p-8 text-center">
      <div className="neon-glow mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-[var(--color-neon)]/20 text-2xl text-[var(--color-neon)]">
        ✦
      </div>
      <h2 className="text-xl font-semibold text-white">Load a model</h2>
      <p className="mt-1 text-sm text-white/50">
        {spec.label} · {gb(spec.approxSizeGB)} · runs entirely on this machine
      </p>

      {busy ? (
        <div className="mt-6">
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--color-neon)] transition-[width]"
              style={{
                width: status === 'initializing' ? '100%' : `${pct}%`,
              }}
            />
          </div>
          <p className="mono mt-3 text-[11px] text-white/50">
            {status === 'initializing'
              ? 'Initializing WebGPU engine…'
              : status === 'reading'
                ? `Reading model from disk · ${pct}%`
                : progress?.totalBytes
                  ? `Downloading ${pct}% · ${gb(
                      progress.receivedBytes / 1e9,
                    )} / ${gb(progress.totalBytes / 1e9)}`
                  : `Downloading ${gb((progress?.receivedBytes ?? 0) / 1e9)}…`}
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
          {linked && (
            <>
              <button
                onClick={() => loadModel({ type: 'linked' })}
                className="neon-glow rounded-xl bg-[var(--color-neon)] px-4 py-3 text-sm font-semibold text-black transition hover:brightness-110"
              >
                Load {spec.label}
              </button>
              <p
                className="mono -mt-1 truncate text-[10px] text-white/35"
                title={linked.path}
              >
                {shortenPath(linked.path)} · {formatBytes(linked.size)}
              </p>
              {mismatch && (
                <p className="mono -mt-1 text-[10px] leading-relaxed text-amber-300/70">
                  ⚠ this file is <span className="text-amber-200">{linked.name}</span>,
                  not {spec.file} — it will load, but the {spec.label} label won’t
                  match the weights
                </p>
              )}
            </>
          )}

          {/* The reliable path for gated Gemma weights: a file the user already
              has. Primary action until something is linked. */}
          <button
            onClick={() => loadModel({ type: 'browse' })}
            className={`rounded-xl px-4 py-3 text-sm font-semibold transition ${
              linked
                ? 'glass text-white hover:bg-white/10'
                : 'neon-glow bg-[var(--color-neon)] text-black hover:brightness-110'
            }`}
          >
            {linked ? 'Choose a different file…' : 'Browse for a .litertlm file…'}
          </button>

          {/* Direct download only works for non-gated repos; secondary link. */}
          <button
            onClick={() => loadModel({ type: 'download' })}
            className="mono text-[11px] text-white/40 underline transition hover:text-white/70"
          >
            or download it now (won’t work for gated models)
          </button>

          <p className="mt-1 text-[11px] leading-relaxed text-white/35">
            Gemma is gated, so a direct download returns a login page. Accept the
            license on{' '}
            <button
              type="button"
              onClick={() => openExternal(spec.url.replace(/\/resolve\/.+$/, ''))}
              className="text-[var(--color-teal)] underline"
            >
              Hugging Face
            </button>
            , download the ~{spec.approxSizeGB} GB{' '}
            <span className="mono">.litertlm</span> (use the file’s ↓ button, not
            the preview link), then browse to it above. It stays where you put it
            — nothing is copied.
          </p>
          <p className="mono mt-1 text-[10px] text-white/30">
            Switch E2B / E4B in ⚙ Settings
          </p>
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
