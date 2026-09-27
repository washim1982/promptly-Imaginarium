
import { net } from 'electron';

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function causeOf(err: unknown): string {
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  return e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(err);
}

export async function httpFetch(url: string, init: HttpInit = {}): Promise<Response> {
  const host = new URL(url).host;
  const retries = init.retries ?? 2;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await net.fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
        credentials: 'omit',
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`${host} didn't respond in time. Check your internet connection and try again.`);
      }
      last = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Couldn't reach ${host} (${causeOf(last)}). Check your internet connection, VPN or proxy, then try again.`);
}

export const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
