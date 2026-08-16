import { useEffect, useState } from 'react';
import { useLlm } from '../state/LlmContext';
import { MODEL_LIST, type ModelId } from '../lib/models';
import { CHAT_WIDTHS } from '../lib/ui';
import { THEMES, isValidHex, resolveAccent } from '../lib/themes';
import { formatBytes, shortenPath, type LinkedModel } from '../lib/desktop';

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    activeModelId,
    setActiveModel,
    settings,
    updateSettings,
    modelFile,
    forgetModel,
    status,
    chatWidth,
    setChatWidth,
    theme,
    customGlow,
    setTheme,
    setCustomGlow,
  } = useLlm();

  const [temp, setTemp] = useState(settings.temperature);
  const [maxTokens, setMaxTokens] = useState(settings.maxNumTokens);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [files, setFiles] = useState<Record<string, LinkedModel | null>>({});
  const [glowText, setGlowText] = useState(
    customGlow ?? resolveAccent(theme, null),
  );

  useEffect(() => {
    let active = true;
    (async () => {
      const out: Record<string, LinkedModel | null> = {};
      for (const m of MODEL_LIST) out[m.id] = await modelFile(m.id);
      if (active) setFiles(out);
    })();
    return () => {
      active = false;
    };
  }, [modelFile, status]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <aside
        className="glass h-full w-full max-w-md overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-white/60 hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {/* Model selection */}
        <section className="mb-7">
          <h3 className="mono mb-3 text-[11px] text-white/40">Model</h3>
          <div className="space-y-2">
            {MODEL_LIST.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                  activeModelId === m.id
                    ? 'border-[var(--color-neon)]/60 bg-[var(--color-neon)]/10'
                    : 'border-white/10 hover:bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name="model"
                  checked={activeModelId === m.id}
                  onChange={() => setActiveModel(m.id as ModelId)}
                  className="mt-1 accent-[var(--color-neon)]"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white">
                      {m.label}
                      {m.default && (
                        <span className="mono ml-2 text-[9px] text-[var(--color-teal)]">
                          default
                        </span>
                      )}
                    </span>
                    <span className="mono text-[10px] text-white/40">
                      ~{m.approxSizeGB} GB
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-white/45">{m.description}</p>
                  {files[m.id] && (
                    <div className="mt-2">
                      <p
                        className="mono truncate text-[10px] text-white/35"
                        title={files[m.id]!.path}
                      >
                        {shortenPath(files[m.id]!.path)} ·{' '}
                        {formatBytes(files[m.id]!.size)}
                      </p>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          void forgetModel(m.id as ModelId).then(() =>
                            setFiles((s) => ({ ...s, [m.id]: null })),
                          );
                        }}
                        title={
                          files[m.id]!.managed
                            ? 'Deletes the copy this app downloaded'
                            : 'Forgets the link — your file is left untouched'
                        }
                        className="mono mt-1 text-[10px] text-white/40 underline hover:text-red-300"
                      >
                        {files[m.id]!.managed ? 'downloaded · delete' : 'linked · forget'}
                      </button>
                    </div>
                  )}
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* Workspace display */}
        <section className="mb-7">
          <h3 className="mono mb-3 flex items-center gap-2 text-[11px] text-[var(--color-neon)]">
            ▣ Workspace Display
          </h3>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-white">Chat Width Adjustment</span>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {CHAT_WIDTHS.find((w) => w.id === chatWidth)?.label}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {CHAT_WIDTHS.map((w) => (
              <button
                key={w.id}
                onClick={() => setChatWidth(w.id)}
                className={`rounded-xl border px-2 py-3 text-center transition ${
                  chatWidth === w.id
                    ? 'neon-glow border-[var(--color-neon)]/70 bg-[var(--color-neon)]/10'
                    : 'border-white/10 hover:bg-white/5'
                }`}
              >
                <div className="text-sm font-semibold text-white">{w.label}</div>
                <div className="mono mt-0.5 text-[9px] text-white/40">
                  {w.sub}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Visual theme */}
        <section className="mb-7">
          <h3 className="mono mb-3 flex items-center gap-2 text-[11px] text-[var(--color-neon)]">
            ◑ System Visual Theme
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => {
              const active = !customGlow && theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setTheme(t.id);
                    setGlowText(t.color);
                  }}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 py-3 transition ${
                    active
                      ? 'neon-glow border-[var(--color-neon)]/70 bg-white/[0.03]'
                      : 'border-white/10 hover:bg-white/5'
                  }`}
                >
                  <span
                    className="h-4 w-4 rounded-full"
                    style={{ background: t.color, boxShadow: `0 0 8px ${t.color}` }}
                  />
                  <span
                    className={`text-[11px] ${
                      active ? 'font-semibold text-white' : 'text-white/60'
                    }`}
                  >
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4">
            <h4 className="mono mb-2 text-[10px] text-white/40">
              Custom Glow Color (Hex)
            </h4>
            <div className="flex items-center gap-2">
              <input
                value={glowText}
                onChange={(e) => {
                  const v = e.target.value;
                  setGlowText(v);
                  if (isValidHex(v)) setCustomGlow(v);
                }}
                placeholder="#ec4899"
                className="mono flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:border-[var(--color-neon)]/50 focus:outline-none"
              />
              <input
                type="color"
                aria-label="Pick glow color"
                value={
                  isValidHex(glowText) && glowText.length >= 7
                    ? glowText.startsWith('#')
                      ? glowText
                      : `#${glowText}`
                    : resolveAccent(theme, customGlow)
                }
                onChange={(e) => {
                  setGlowText(e.target.value);
                  setCustomGlow(e.target.value);
                }}
                className="h-9 w-12 cursor-pointer rounded-lg border border-white/10 bg-transparent"
              />
            </div>
          </div>
        </section>

        {/* Temperature */}
        <section className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Temperature</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {temp.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={temp}
            onChange={(e) => setTemp(Number(e.target.value))}
            onMouseUp={() => updateSettings({ temperature: temp })}
            onTouchEnd={() => updateSettings({ temperature: temp })}
            className="w-full accent-[var(--color-neon)]"
          />
        </section>

        {/* Max tokens */}
        <section className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Max tokens</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {maxTokens}
            </span>
          </div>
          <input
            type="range"
            min={512}
            max={8192}
            step={256}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            onMouseUp={() => updateSettings({ maxNumTokens: maxTokens })}
            onTouchEnd={() => updateSettings({ maxNumTokens: maxTokens })}
            className="w-full accent-[var(--color-neon)]"
          />
          <p className="mt-1 text-[10px] text-white/30">
            Applies on next model load.
          </p>
        </section>

        {/* System prompt */}
        <section>
          <h3 className="mono mb-2 text-[11px] text-white/40">System prompt</h3>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            onBlur={() => updateSettings({ systemPrompt })}
            rows={4}
            className="w-full resize-none rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white focus:border-[var(--color-neon)]/50 focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-white/30">
            Saved on blur · resets the conversation.
          </p>
        </section>
      </aside>
    </div>
  );
}
