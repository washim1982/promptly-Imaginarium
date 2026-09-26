import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { searchProviders } from './electron/search/providers';

// @litert-lm/core ships sourcemap comments without the original sources, so Vite
// logs "Sourcemap ... points to missing source files". Harmless — filter it out.
const logger = createLogger();
const originalWarn = logger.warn;
const isSourcemapNoise = (msg: string) =>
  msg.includes('points to missing source files') ||
  /Sourcemap for .*@litert-lm/.test(msg);
logger.warn = (msg, opts) => {
  if (isSourcemapNoise(msg)) return;
  originalWarn(msg, opts);
};
logger.warnOnce = ((msg: string, opts: any) => {
  if (isSourcemapNoise(msg)) return;
  originalWarn(msg, opts);
}) as typeof logger.warnOnce;

// LiteRT-LM needs SharedArrayBuffer, which needs cross-origin isolation. In the
// packaged app the app:// protocol handler sets these (see electron/main.ts);
// the dev server has to set them itself.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

const SEARCH_API = process.env.ORIOSEARCH_URL ?? 'http://localhost:8005';
const searchBackend = {
  name: 'search-backend',
  configureServer(server: any) {
    server.middlewares.use('/api/search', async (req: any, res: any) => {
      res.setHeader('Content-Type', 'application/json');
      try {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Use POST.' })); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error('Search request is too large.'); }
        const { query } = JSON.parse(body);
        if (typeof query !== 'string' || !query.trim()) throw new Error('Enter a search query.');
        const results = await searchProviders((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs) }), query.trim(), 12, process.env.KEENABLE_API_KEY, process.env.TAVILY_API_KEY);
        res.end(JSON.stringify({ results }));
      } catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: (error as Error).message })); }
    });
  },
};

export default defineConfig({
  base: './',
  customLogger: logger,
  plugins: [react(), tailwindcss(), crossOriginIsolation, searchBackend],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
    // Mirrors the packaged app's /api/* handling so dev and prod behave the
    // same; in production electron/main.ts proxies these instead.
    proxy: {
      '/api/extract': {
        target: SEARCH_API,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/extract/, '/extract'),
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps make Electron's devtools usable against the bundle.
    sourcemap: true,
  },
  // @litert-lm/core ships large wasm/worker assets; don't pre-bundle them.
  optimizeDeps: { exclude: ['@litert-lm/core'] },
  css: { devSourcemap: false },
});
