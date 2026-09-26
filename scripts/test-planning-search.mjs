import { transform } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
const dir = new URL('../node_modules/.tmp/planning-checks/', import.meta.url);
await mkdir(dir, { recursive: true });
try {
  for (const [name, source] of [['providers', 'electron/search/providers.ts'], ['planning', 'src/lib/planning.ts']]) {
    const result = await transform(await readFile(source, 'utf8'), { loader: 'ts', format: 'esm' });
    await writeFile(new URL(`${name}.mjs`, dir), result.code);
  }
  const { searchProviders, normalizeResults } = await import(new URL('providers.mjs', dir));
  const { endExclusive, calendarFile, calendarUrl, mapsUrl } = await import(new URL('planning.mjs', dir));
  const hit = { title: 'Family attraction', url: 'https://example.com', snippet: 'Hours and admission' };
  let calls = [];
  const primary = await searchProviders(async (url, init) => { calls.push({ url, init }); return Response.json({ results: [hit] }); }, 'family trip', 3);
  assert.equal(primary[0].content, hit.snippet);
  assert.match(calls[0].url, /search\/public$/);
  assert.equal(calls[0].init.headers['X-Keenable-Title'], 'OMNI-STUDIO');
  assert.equal(calls.length, 1);
  for (const failure of ['http', 'network', 'invalid', 'empty']) {
    calls = [];
    const results = await searchProviders(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'http') return new Response('', { status: 429 });
        return Response.json(failure === 'empty' ? { results: [] } : {});
      }
      return Response.json({ results: [{ ...hit, content: 'Fallback' }] });
    }, 'trip', 3, 'keen_test', 'tvly_test');
    assert.equal(results.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers['X-API-Key'], 'keen_test');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer tvly_test');
    assert.equal(calls[1].init.headers['X-API-Key'], undefined);
  }
  await assert.rejects(() => searchProviders(async () => new Response('', { status: 503 }), 'trip', 3), /Add a Tavily fallback key/);
  await assert.rejects(() => searchProviders(async () => new Response('', { status: 503 }), 'trip', 3, '', 'tvly_test'), /Tavily fallback failed/);
  assert.deepEqual(normalizeResults({ results: [null, { title: 'Unsafe', url: 'javascript:alert(1)' }] }, 3), []);
  assert.equal(endExclusive('2028-02-29'), '20280301');
  assert.equal(endExclusive('2026-12-31'), '20270101');
  const plan = { title: 'Family, fun; together', location: 'Denver & Boulder', start: '2026-12-30', end: '2026-12-31' };
  const ics = calendarFile(plan, 'Line one\n' + '🌍'.repeat(80));
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
  assert.match(ics, /SUMMARY:Family\\, fun\\; together/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(new URL(calendarUrl(plan, 'Plan')).searchParams.get('dates'), '20261230/20270101');
  assert.equal(new URL(mapsUrl(plan.location)).searchParams.get('query'), plan.location);
  console.log('Passed: primary and fallback search, authentication isolation, malformed results, calendar boundaries, escaping, UTF-8 folding and external links.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
