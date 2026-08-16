import { useLlm } from '../../state/LlmContext';
import { MODELS } from '../../lib/models';

const DOT: Record<string, string> = {
  ready: 'bg-[var(--color-neon)]',
  initializing: 'bg-amber-400 animate-pulse',
  downloading: 'bg-amber-400 animate-pulse',
  reading: 'bg-amber-400 animate-pulse',
  idle: 'bg-white/30',
  error: 'bg-red-500',
  unsupported: 'bg-red-500',
  'checking-gpu': 'bg-white/30 animate-pulse',
};

export default function StatusPill() {
  const { status, activeModelId, settings } = useLlm();
  const label = MODELS[activeModelId].label;

  const text =
    status === 'ready'
      ? `Local: ${label} / TEMP ${settings.temperature.toFixed(2)}`
      : status === 'downloading'
        ? `Downloading ${label}…`
        : status === 'reading'
          ? `Reading ${label} from disk…`
          : status === 'initializing'
            ? `Loading ${label} into GPU…`
            : status === 'idle'
              ? `${label} — not loaded`
              : status === 'error'
                ? 'Engine error'
                : status === 'unsupported'
                  ? 'WebGPU unavailable'
                  : 'Checking GPU…';

  return (
    <div className="mono inline-flex items-center gap-2 text-[11px] text-white/55">
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status] ?? 'bg-white/30'}`} />
      {text}
    </div>
  );
}
