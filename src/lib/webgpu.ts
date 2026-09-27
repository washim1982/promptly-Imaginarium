
export interface GpuSupport {
  supported: boolean;
  reason?: string;
  adapter?: string;
}

export async function detectWebGPU(): Promise<GpuSupport> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return {
      supported: false,
      reason:
        'WebGPU is not available in this browser. Use a recent version of Chrome or Edge.',
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        reason:
          'No compatible GPU adapter was found. Your hardware or driver may not support WebGPU.',
      };
    }
    const info =
      (adapter as any).info ??
      ((adapter as any).requestAdapterInfo
        ? await (adapter as any).requestAdapterInfo()
        : undefined);
    const name = info
      ? [info.vendor, info.architecture].filter(Boolean).join(' ').trim()
      : undefined;
    return { supported: true, adapter: name || 'WebGPU adapter' };
  } catch (err) {
    return {
      supported: false,
      reason: `WebGPU initialization failed: ${(err as Error).message}`,
    };
  }
}
