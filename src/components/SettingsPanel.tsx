import { useState } from 'react';
import { useLlm } from '../state/LlmContext';
import { CHAT_WIDTHS } from '../lib/ui';
import { THEMES, isValidHex, resolveAccent } from '../lib/themes';
import { desktop, formatBytes, shortenPath } from '../lib/desktop';
import { usePrompt } from './PromptDialog';

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    models,
    activeModelId,
    setActiveModel,
    settings,
    updateSettings,
    addModels,
    removeModel,
    renameModel,
    chatWidth,
    setChatWidth,
    theme,
    customGlow,
    setTheme,
    setCustomGlow,
  } = useLlm();

  const ask = usePrompt();
  const [temp, setTemp] = useState(settings.temperature);
  const [topK, setTopK] = useState(settings.topK);
  const [topP, setTopP] = useState(settings.topP);
  const [maxOutput, setMaxOutput] = useState(settings.maxOutputTokens);
  const [maxTokens, setMaxTokens] = useState(settings.maxNumTokens);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [glowText, setGlowText] = useState(
    customGlow ?? resolveAccent(theme, null),
  );

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

        {/* Model library — any number of .litertlm files, added by browsing. */}
        <section className="mb-7">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">
              Model library ({models.length})
            </h3>
            <button
              onClick={() => void addModels()}
              className="mono rounded-md border border-white/15 px-2 py-1 text-[10px] text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              ＋ Add model…
            </button>
          </div>

          {models.length === 0 ? (
            <p className="mono rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-[10px] leading-relaxed text-white/30">
              No models yet. Add any LiteRT-LM
              <br />
              <span className="text-white/45">.litertlm</span> file to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {models.map((m) => {
                const active = activeModelId === m.id;
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                      active
                        ? 'border-[var(--color-neon)]/60 bg-[var(--color-neon)]/10'
                        : 'border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <input
                      type="radio"
                      name="model"
                      checked={active}
                      onChange={() => setActiveModel(m.id)}
                      className="mt-1 accent-[var(--color-neon)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-white">
                          {m.label}
                        </span>
                        <span className="mono shrink-0 text-[10px] text-white/40">
                          {formatBytes(m.size)}
                        </span>
                      </div>
                      <p
                        className="mono mt-0.5 truncate text-[10px] text-white/35"
                        title={m.path}
                      >
                        {shortenPath(m.path)}
                      </p>
                      <div className="mono mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/40">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            // window.prompt() throws in Electron; use the in-app dialog.
                            void ask({ title: 'Rename model', defaultValue: m.label, confirmLabel: 'Rename' }).then(
                              (next) => {
                                if (next != null) void renameModel(m.id, next);
                              },
                            );
                          }}
                          className="underline hover:text-white"
                        >
                          rename
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            void desktop?.revealModel(m.id);
                          }}
                          className="underline hover:text-white"
                        >
                          show in folder
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            const warning = m.managed
                              ? `Delete "${m.label}"? This app downloaded it, so the file will be deleted from disk.`
                              : `Remove "${m.label}" from the library? Your file stays where it is.`;
                            if (window.confirm(warning)) void removeModel(m.id);
                          }}
                          title={
                            m.managed
                              ? 'Deletes the copy this app downloaded'
                              : 'Removes it from the list — your file is left untouched'
                          }
                          className="underline hover:text-red-300"
                        >
                          {m.managed ? 'delete' : 'remove'}
                        </button>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
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

        {/* Top-K / Top-P. These are not cosmetic: without them the sampler
            falls back to greedy decoding and ignores the temperature. */}
        <section className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Top-K</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">{topK}</span>
          </div>
          <input
            type="range"
            min={1}
            max={128}
            step={1}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            onMouseUp={() => updateSettings({ topK })}
            onTouchEnd={() => updateSettings({ topK })}
            className="w-full accent-[var(--color-neon)]"
          />
          <div className="mb-2 mt-4 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Top-P</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {topP.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.01}
            value={topP}
            onChange={(e) => setTopP(Number(e.target.value))}
            onMouseUp={() => updateSettings({ topP })}
            onTouchEnd={() => updateSettings({ topP })}
            className="w-full accent-[var(--color-neon)]"
          />
          <p className="mt-1 text-[10px] text-white/30">
            Gemma's reference values are 64 / 0.95. Very low settings decode
            greedily and can loop.
          </p>
        </section>

        {/* Reply length cap */}
        <section className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Max reply tokens</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {maxOutput}
            </span>
          </div>
          <input
            type="range"
            min={256}
            max={8192}
            step={256}
            value={maxOutput}
            onChange={(e) => setMaxOutput(Number(e.target.value))}
            onMouseUp={() => updateSettings({ maxOutputTokens: maxOutput })}
            onTouchEnd={() => updateSettings({ maxOutputTokens: maxOutput })}
            className="w-full accent-[var(--color-neon)]"
          />
          <p className="mt-1 text-[10px] text-white/30">
            Stops a single reply from running away. Applies to the next reply.
          </p>
        </section>

        {/* Context window */}
        <section className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="mono text-[11px] text-white/40">Context window</h3>
            <span className="mono text-[11px] text-[var(--color-neon)]">
              {maxTokens}
            </span>
          </div>
          <input
            type="range"
            min={512}
            max={32768}
            step={512}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            onMouseUp={() => updateSettings({ maxNumTokens: maxTokens })}
            onTouchEnd={() => updateSettings({ maxNumTokens: maxTokens })}
            className="w-full accent-[var(--color-neon)]"
          />
          <p className="mt-1 text-[10px] text-white/30">
            Sizes the KV cache in GPU memory. Applies on next model load.
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
