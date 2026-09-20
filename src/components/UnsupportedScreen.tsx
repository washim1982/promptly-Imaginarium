import { useLlm } from '../state/LlmContext';

// Desktop framing: Electron bundles its own Chromium, so "update your browser"
// is never the answer here — if WebGPU is missing it's the GPU, the driver, or
// hardware acceleration being off.
export default function UnsupportedScreen() {
  const { gpu } = useLlm();
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <div className="glass w-full max-w-lg rounded-[var(--radius-panel)] p-10">
        <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-red-500/15 text-2xl">
          ⚠
        </div>
        <h1 className="text-2xl font-semibold text-white">WebGPU is required</h1>
        <p className="mt-3 text-sm text-white/55">
          {gpu?.reason ??
            'No WebGPU device is available. OMNI-STUDIO runs Gemma on your GPU and has no CPU fallback.'}
        </p>
        <div className="mono mt-6 space-y-1 text-left text-[11px] text-white/40">
          <p>· Update your GPU driver (NVIDIA / AMD / Intel)</p>
          <p>· A discrete or recent integrated GPU with Vulkan or D3D12 support</p>
          <p>· Check that hardware acceleration isn’t disabled system-wide</p>
          <p>· Remote Desktop sessions often expose no usable GPU adapter</p>
        </div>
      </div>
    </div>
  );
}
