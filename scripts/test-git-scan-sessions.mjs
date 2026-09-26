import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Exercise IPC without changing real repositories or their history.
const handlers = new Map();
let sequence = 0;
let removed = [];
let refreshFails = false;
const summary = { historyRewritten: true };
const mocks = {
  electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
  'node:child_process': {}, 'node:path': path, 'node:fs/promises': {},
  'node:crypto': { randomUUID },
  './gitService': {
    resolveRepoRoot: async root => root,
    getRepoState: async () => { if (refreshFails) throw new Error('Refresh failed'); return {}; },
  },
  './secretScan': {
    scanRepository: async () => ({ secrets: new Map([['finding', `fixture-${++sequence}`]]), findings: [{ id: 'finding' }] }),
    scanStaged: async () => ({ secrets: new Map(), findings: [] }),
    collectCandidates: async () => ({ candidates: [{ id: 'ai', value: 'candidate-fixture' }] }),
  },
  './historyRewrite': { removeSecrets: async (root, values) => { removed.push({ root, values }); return summary; } },
};
const { code } = await transform(await readFile('electron/git/ipc.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(name => {
  if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
  return mocks[name];
}, module, module.exports);
module.exports.registerGitIpc();
const call = (name, ...args) => handlers.get(`git:${name}`)({}, ...args);
const first = await call('scanSecrets', 'C:/Repos/One');
const second = await call('scanSecrets', 'C:/Repos/Two');
assert.notEqual(first.scanId, second.scanId);
assert.equal(first.secrets, undefined);
await call('scanStaged', 'C:/Repos/One');
await call('scanCandidates', 'C:/Repos/One', first.scanId);
await assert.rejects(() => call('removeSecrets', 'C:/Repos/Two', ['finding'], first.scanId), /SCAN_EXPIRED/);
await assert.rejects(() => call('removeSecrets', 'C:/Repos/One', ['unknown'], first.scanId), /SCAN_EXPIRED/);
assert.equal(removed.length, 0);
const equivalent = process.platform === 'win32' ? 'c:\\repos\\one' : 'C:/Repos/One';
await call('removeSecrets', equivalent, ['finding', 'ai'], first.scanId);
assert.deepEqual(removed[0].values, ['fixture-1', 'candidate-fixture']);
await assert.rejects(() => call('removeSecrets', 'C:/Repos/One', ['finding'], first.scanId), /SCAN_EXPIRED/);
await call('scanCandidates', 'C:/Repos/Two', second.scanId);
const older = await call('scanSecrets', 'C:/Repos/Two');
refreshFails = true;
const result = await call('removeSecrets', 'C:/Repos/Two', ['finding'], second.scanId);
assert.equal(result.summary, summary);
assert.equal(result.state, null);
assert.match(result.warning, /Removal completed/);
assert.deepEqual(removed[1].values, ['fixture-2']);
await assert.rejects(() => call('scanCandidates', 'C:/Repos/Two', older.scanId), /SCAN_EXPIRED/);
const evicted = await call('scanSecrets', 'C:/Repos/Old');
for (let i = 0; i < 8; i++) await call('scanSecrets', `C:/Repos/${i}`);
await assert.rejects(() => call('scanCandidates', 'C:/Repos/Old', evicted.scanId), /SCAN_EXPIRED/);
console.log('Passed: scan isolation, Windows path equivalence, staged scan independence, exact selected values, stale/unknown findings, duplicate removal, refresh failure and cache eviction.');
