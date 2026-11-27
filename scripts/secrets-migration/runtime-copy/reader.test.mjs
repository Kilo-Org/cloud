// The reader leg of the name mapping (M89b), proved on the real Notifications reader for all four
// lookup names, including the three secrets-cutover writes from 1Password (M108): for every name
// map row, `readNotificationsSecret(env, <STS lookup name>)` must read exactly that row's legacy
// binding under `secrets-store` and exactly that lookup name from a fake STS bundle under `sts`,
// with only that row populated in each source (pattern of
// services/notifications/src/__tests__/secrets-source.test.ts).
// Runs under tsx (root `test:secrets-migration`) so the TypeScript reader imports as shipped.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { BATCH } from './fakes.mjs';
import { WORKER_SOURCES, mappingRows, parseReaderBindings, readTrackedSource } from './checks.mjs';
import { REPO_ROOT } from './render-config.mjs';

const SRC = WORKER_SOURCES.notifications;
const NAME_MAP = SRC.names;

const { readNotificationsSecret } = await import(
  pathToFileURL(join(REPO_ROOT, 'services/notifications/src/secrets.ts')).href
);

const ctx = () => ({ waitUntil: () => {} });

function fakeStore(value) {
  const calls = { n: 0 };
  return { calls, secret: { get: async () => (calls.n++, value) } };
}

function fakeSts(secrets) {
  const calls = { n: 0 };
  const binding = {
    getBundle: async () => {
      calls.n++;
      return {
        status: 'ok',
        workload: 'notifications',
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

test('each row selects its own value in both source modes, with only that row populated', async () => {
  for (const row of NAME_MAP) {
    const store = fakeStore(`store-only-${row.binding}`);
    const sts = fakeSts({ [row.secretKey]: `bundle-only-${row.secretKey}` });
    const env = { [row.binding]: store.secret, STS: sts.binding };
    assert.equal(
      await readNotificationsSecret(env, row.secretKey, ctx()),
      `store-only-${row.binding}`
    );
    assert.deepEqual([store.calls.n, sts.calls.n], [1, 0], `${row.secretKey}: legacy read only`);
    assert.equal(
      await readNotificationsSecret({ ...env, SECRETS_SOURCE: 'sts' }, row.secretKey, ctx()),
      `bundle-only-${row.secretKey}`
    );
    assert.deepEqual([store.calls.n, sts.calls.n], [1, 1], `${row.secretKey}: bundle read only`);

    // Every other lookup name misses in both sources: no row reads another row's binding or key.
    for (const other of NAME_MAP.filter(r => r !== row)) {
      await assert.rejects(
        readNotificationsSecret(env, other.secretKey, ctx()),
        `${other.secretKey} legacy`
      );
      await assert.rejects(
        readNotificationsSecret(
          { ...env, SECRETS_SOURCE: 'sts', STS: fakeSts({ [row.secretKey]: 'x' }).binding },
          other.secretKey,
          ctx()
        ),
        `${other.secretKey} sts`
      );
    }
  }
});

test('the store names and unprefixed legacy names are not lookup names', async () => {
  const env = Object.fromEntries(NAME_MAP.map(r => [r.binding, fakeStore('v').secret]));
  for (const name of [
    'APNS_PRIVATE_KEY_PROD',
    'NEXTAUTH_SECRET_PROD',
    'INTERNAL_API_SECRET_PROD',
    'APNS_PRIVATE_KEY',
    'EXPO_ACCESS_TOKEN',
  ]) {
    await assert.rejects(readNotificationsSecret(env, name, ctx()), name);
  }
});

test('the parsed reader map and the four-column rows agree with the reader behaviour', () => {
  const sources = readTrackedSource(SRC);
  const reader = parseReaderBindings(sources.readerText, SRC.readerMap);
  assert.deepEqual(
    Object.entries(reader).sort(),
    NAME_MAP.map(r => [r.secretKey, r.binding]).sort()
  );
  const rows = mappingRows(sources, SRC);
  assert.deepEqual(
    rows.map(r => [r.binding, r.storeSecretName, r.lookup, r.policyEntry]),
    NAME_MAP.map(r => [r.binding, r.secretName, r.secretKey, r.secretKey])
  );
  // The copy batch is the Expo row of the name map, read back through the same reader key.
  assert.deepEqual(
    BATCH.rows.map(r => [r.secretKey, reader[r.secretKey]]),
    [['NOTIFICATIONS_EXPO_ACCESS_TOKEN', 'EXPO_ACCESS_TOKEN']]
  );
});
