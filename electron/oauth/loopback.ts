// Shared pieces of the browser sign-in flows (Google, Auth0): PKCE, random
// state/nonce, and a one-shot loopback listener that receives the redirect.
// RFC 8252 "OAuth 2.0 for Native Apps": the consent page opens in the user's
// own browser and redirects back to 127.0.0.1.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const base64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomToken = (bytes = 16) => base64url(randomBytes(bytes));

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export const resultPage = (ok: boolean, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Imaginarium</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0c0e12;color:#ece9f1;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:40px;color:${ok ? '#3fb950' : '#f85149'}">${ok ? '✓' : '✕'}</div>
<h2 style="font-weight:600">${message}</h2><p style="color:#8b8597">You can close this tab and return to Imaginarium.</p></div></body>`;

export interface LoopbackOptions {
  expectedState: string;
  /** 0 = any free port (Google accepts any loopback port); Auth0 needs the registered one. */
  port: number;
  /** Path the redirect arrives on, e.g. "/" or "/callback". */
  path: string;
  /** Shown in the browser tab after a successful redirect. */
  successMessage: string;
  /** Turns the provider's `error` / `error_description` into a user-facing message. */
  describeError: (error: string, description: string) => string;
}

/** Listen for the provider's redirect; `code` resolves with the authorization code. */
export function listenForCode(opts: LoopbackOptions): Promise<{ server: Server; port: number; code: Promise<string> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
    const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    // If a timeout/cancel wins the caller's race first, a later rejection here
    // must not surface as an unhandled rejection.
    code.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== opts.path) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const value = url.searchParams.get('code');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.searchParams.get('state') !== opts.expectedState) {
        // Not our request (or a forged one): answer, but keep waiting.
        res.writeHead(400).end(resultPage(false, 'This sign-in link is not valid.'));
        return;
      }
      if (error || !value) {
        const message = opts.describeError(error ?? 'no_code', url.searchParams.get('error_description') ?? '');
        res.writeHead(200).end(resultPage(false, message));
        settle.reject(new Error(message));
        return;
      }
      res.writeHead(200).end(resultPage(true, opts.successMessage));
      settle.resolve(value);
    });
    server.on('error', (err: NodeJS.ErrnoException) =>
      rejectListen(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${opts.port} is already in use, so the sign-in can't receive its reply. Close whatever is using it and try again.`)
          : err,
      ),
    );
    server.listen(opts.port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return rejectListen(new Error('Could not open a local port for sign-in.'));
      resolveListen({ server, port: address.port, code });
    });
  });
}

/** A cancellable timeout to race against `code`. */
export function signInDeadline(ms: number, label: string): { promise: Promise<never>; cancel: () => void; clear: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let cancel = () => {};
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out. Try again.`)), ms);
    cancel = () => reject(new Error(`${label} was cancelled.`));
  });
  promise.catch(() => {});
  return { promise, cancel: () => cancel(), clear: () => clearTimeout(timer) };
}
