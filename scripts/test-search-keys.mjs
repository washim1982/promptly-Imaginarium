import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Run the main-process key lifecycle against isolated storage/network mocks.
const files = new Map();
let encryptedStorage = true;
let rejected = false;
let request;
let selected;
const mocks = {
  electron: {
    app: { getPath: () => 'test-user-data' },
    safeStorage: {
      isEncryptionAvailable: () => encryptedStorage,
      encryptString: value => Buffer.from(`encrypted:${value}`),
      decryptString: value => value.toString().slice('encrypted:'.length),
    },
  },
  'node:fs/promises': {
    mkdir: async () => {},
    readFile: async file => { if (!files.has(file)) throw new Error('Missing'); return files.get(file); },
    writeFile: async (file, value) => { files.set(file, value); },
    rm: async file => { files.delete(file); },
  },
  'node:path': path,
  '../oauth/http': { httpFetch: async (url, init) => {
    request = { url, init };
    return rejected ? new Response('', { status: 401 }) : Response.json({ results: [] });
  } },
  './providers': {
    normalizeResults: data => data.results,
    searchProviders: async (_fetch, _query, _limit, keenable, tavily) => { selected = { keenable, tavily }; return []; },
  },
};
const savedEnv = { keenable: process.env.KEENABLE_API_KEY, tavily: process.env.TAVILY_API_KEY };
delete process.env.KEENABLE_API_KEY;
delete process.env.TAVILY_API_KEY;
try {
  const { code } = await transform(await readFile('electron/search/tavily.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
    return mocks[name];
  }, module, module.exports);
  const api = module.exports;
  const keen = 'keen_test_1234567890';
  const tavily = 'tvly-test_1234567890';
  await api.saveKey(tavily);
  let status = await api.saveKey(keen, 'keenable');
  assert.equal(status.keenableSource, 'saved');
  assert.ok(!JSON.stringify(status).includes(keen));
  assert.equal(files.size, 2);
  assert.ok([...files.values()].every(value => value.toString().startsWith('encrypted:')));
  await api.search('trip');
  assert.deepEqual(selected, { keenable: keen, tavily });
  await api.verifyKey('', 'keenable');
  assert.equal(request.url, 'https://api.keenable.ai/v1/search');
  assert.equal(request.init.headers['X-API-Key'], keen);
  rejected = true;
  await assert.rejects(() => api.verifyKey('', 'keenable'), /401/);
  process.env.KEENABLE_API_KEY = '***REMOVED***';
  assert.equal((await api.status()).keenableSource, 'env');
  await api.search('trip');
  assert.equal(selected.keenable, process.env.KEENABLE_API_KEY);
  delete process.env.KEENABLE_API_KEY;
  status = await api.clearKey('keenable');
  assert.equal(status.keenableSource, null);
  assert.equal(status.source, 'saved');
  await api.search('trip');
  assert.deepEqual(selected, { keenable: undefined, tavily });
  encryptedStorage = false;
  await api.saveKey(keen, 'keenable');
  assert.equal(files.size, 1);
  await api.search('trip');
  assert.equal(selected.keenable, keen);
  await api.clearKey('keenable');
  await assert.rejects(() => api.saveKey(keen, '../invalid'), /Unknown search provider/);
  console.log('Passed: separate encrypted keys, masking, saved-key search and verification, rejected key, environment precedence, removal, volatile storage and provider validation.');
} finally {
  for (const [name, value] of [['KEENABLE_API_KEY', savedEnv.keenable], ['TAVILY_API_KEY', savedEnv.tavily]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
