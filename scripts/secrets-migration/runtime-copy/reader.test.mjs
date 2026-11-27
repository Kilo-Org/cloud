// The reader leg of the name mapping (M89b), proved on each reviewed Worker's real reader for every
// lookup name it has: for every reader key, `<readerFn>(env, <STS lookup name>)` must read exactly
// that key's legacy binding under `secrets-store` and exactly that lookup name from a fake STS
// bundle under `sts`, with only that key populated in each source (pattern of
// services/notifications/src/__tests__/secrets-source.test.ts). Store names and legacy binding names
// that are not lookup names must not resolve. A Worker whose reader is not on this checkout yet
// (its batch PR is unmerged: `source_not_on_main`) is skipped by name; the VM proof overlays the
// batch files so every Worker runs.
// Runs under tsx (root `test:secrets-migration`) so the TypeScript readers import as shipped.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { BATCH } from './fakes.mjs';
import { TABLE } from './src/table.mjs';
import {
  WORKER_SOURCES,
  mappingRows,
  parseReaderBindings,
  readTrackedSource,
  readerKeysOf,
} from './checks.mjs';
import { REPO_ROOT } from './render-config.mjs';

const ctx = () => ({ waitUntil: () => {} });

function fakeStore(value) {
  const calls = { n: 0 };
  return { calls, secret: { get: async () => (calls.n++, value) } };
}

function fakeSts(workload, secrets) {
  const calls = { n: 0 };
  const binding = {
    getBundle: async () => {
      calls.n++;
      return {
        status: 'ok',
        workload,
        environment: 'production',
        etag: '"0123456789abcdef"',
        stale: false,
        fetchedAt: '2026-11-27T00:00:00.000Z',
        secrets: Object.fromEntries(
          Object.entries(secrets).map(([k, v]) => [k, { value: v, version: 1 }])
        ),
        missing: [],
      };
    },
  };
  return { calls, binding };
}

/** Reader key -> legacy binding, from the reviewed entry. */
const entriesOf = src => [
  ...src.names.map(r => [r.secretKey, r.binding]),
  ...src.plainSecrets.map(p => [p, p]),
];

/** The copy rows read back through the reader: the checked-in table's, or the fixture's. */
const copyRowsOf = worker =>
  worker === 'notifications' ? BATCH.rows : (TABLE.batches[worker]?.rows ?? []);

for (const [worker, src] of Object.entries(WORKER_SOURCES)) {
  const onMain = existsSync(join(REPO_ROOT, src.reader));
  const skip = onMain ? false : `source_not_on_main: ${worker}`;
  const load = async () =>
    (await import(pathToFileURL(join(REPO_ROOT, src.reader)).href))[src.readerFn];

  test(
    `${worker}: each reader key selects its own value in both source modes, alone`,
    { skip },
    async () => {
      const read = await load();
      assert.equal(typeof read, 'function', src.readerFn);
      const entries = entriesOf(src);
      for (const [key, binding] of entries) {
        const store = fakeStore(`store-only-${binding}`);
        const sts = fakeSts(src.workload, { [key]: `bundle-only-${key}` });
        const env = { [binding]: store.secret, STS: sts.binding };
        assert.equal(await read(env, key, ctx()), `store-only-${binding}`);
        assert.deepEqual([store.calls.n, sts.calls.n], [1, 0], `${key}: legacy read only`);
        assert.equal(
          await read({ ...env, SECRETS_SOURCE: 'sts' }, key, ctx()),
          `bundle-only-${key}`
        );
        assert.deepEqual([store.calls.n, sts.calls.n], [1, 1], `${key}: bundle read only`);

        // Every other lookup name misses in both sources: no key reads another key's binding.
        for (const [other] of entries.filter(([k]) => k !== key)) {
          await assert.rejects(read(env, other, ctx()), `${other} legacy`);
          await assert.rejects(
            read(
              {
                ...env,
                SECRETS_SOURCE: 'sts',
                STS: fakeSts(src.workload, { [key]: 'x' }).binding,
              },
              other,
              ctx()
            ),
            `${other} sts`
          );
        }
      }
    }
  );

  test(
    `${worker}: store names and legacy binding names are not lookup names`,
    { skip },
    async () => {
      const read = await load();
      const keys = new Set(readerKeysOf(src));
      const stored = [...src.names, ...src.legacyStoreBindings];
      const env = Object.fromEntries(entriesOf(src).map(([, b]) => [b, fakeStore('v').secret]));
      const names = [...new Set(stored.flatMap(r => [r.secretName, r.binding]))].filter(
        n => !keys.has(n)
      );
      for (const name of names) await assert.rejects(read(env, name, ctx()), name);
    }
  );

  test(
    `${worker}: the parsed reader map and the four-column rows agree with the reader`,
    { skip },
    () => {
      const sources = readTrackedSource(src);
      const reader = parseReaderBindings(sources.readerText, src.readerMap);
      assert.deepEqual(Object.entries(reader).sort(), entriesOf(src).sort());
      const rows = mappingRows(sources, src);
      assert.deepEqual(
        rows.map(r => [r.binding, r.storeSecretName, r.lookup, r.policyEntry]),
        src.names.map(r => [r.binding, r.secretName, r.secretKey, r.secretKey])
      );
      // Each copy row reads back through the same reader key: target = lookup.
      for (const r of copyRowsOf(worker)) assert.equal(reader[r.secretKey], r.binding, r.secretKey);
    }
  );
}
