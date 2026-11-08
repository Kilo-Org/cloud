import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const mobileManifestUrl = new URL('../apps/mobile/package.json', import.meta.url);
const mobileRequire = createRequire(mobileManifestUrl);
const mobileManifest = JSON.parse(readFileSync(mobileManifestUrl, 'utf8'));
const easManifestPath = mobileRequire.resolve('eas-cli/package.json');
const easManifest = JSON.parse(readFileSync(easManifestPath, 'utf8'));
const easRequire = createRequire(easManifestPath);
const deepMergePath = easRequire.resolve('ts-deepmerge');
const deepMergeManifest = JSON.parse(
  readFileSync(join(dirname(deepMergePath), '..', 'package.json'), 'utf8')
);
const { merge } = easRequire('ts-deepmerge');
const { generateAppConfigAsync } = easRequire('./build/commandUtils/new/projectFiles.js');

const unsafeKeys = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

function unsafeObject() {
  return Object.fromEntries([...unsafeKeys.map(key => [key, 0]), ['retained', 'safe']]);
}

function assertSafeObject(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of unsafeKeys) {
    assert.equal(Object.hasOwn(value, key), false, key);
  }
  assert.equal(String(value), '[object Object]');
}

test('mobile EAS resolves the fixed ts-deepmerge named export', () => {
  assert.equal(mobileManifest.devDependencies['eas-cli'], '24.13.0');
  assert.equal(easManifest.version, '24.13.0');
  assert.equal(deepMergeManifest.version, '8.0.0');
  assert.equal(typeof merge, 'function');
});

test('ts-deepmerge preserves nested configuration and array semantics', () => {
  const base = {
    plugins: ['alpha', 'shared'],
    extra: { eas: { channel: 'stable' }, flag: 'old' },
    ios: { bundleIdentifier: 'old', buildNumber: '1' },
  };
  const original = structuredClone(base);
  const result = merge(base, {
    plugins: ['shared', 'beta'],
    extra: { eas: { projectId: 'new-id' }, flag: 'new' },
    ios: { bundleIdentifier: 'new' },
  });

  assert.deepEqual(result, {
    plugins: ['alpha', 'shared', 'beta'],
    extra: { eas: { channel: 'stable', projectId: 'new-id' }, flag: 'new' },
    ios: { bundleIdentifier: 'new', buildNumber: '1' },
  });
  assert.deepEqual(base, original);
});

test('ts-deepmerge filters unsafe keys on new and existing nested objects', () => {
  const unsafe = unsafeObject();
  const result = merge(
    { ...unsafe, nested: { before: 'existing' }, introduced: unsafe },
    { nested: { ...unsafe, after: 'new' } }
  );

  assert.deepEqual(result, {
    retained: 'safe',
    nested: { before: 'existing', retained: 'safe', after: 'new' },
    introduced: { retained: 'safe' },
  });
  for (const value of [result, result.nested, result.introduced]) {
    assertSafeObject(value);
  }
});

test('EAS generates app config using the fixed merge without losing existing settings', async t => {
  const projectDir = await mkdtemp(join(tmpdir(), 'eas-config-test-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  const unsafe = unsafeObject();
  const appJsonPath = join(projectDir, 'app.json');
  await writeFile(
    appJsonPath,
    JSON.stringify({
      expo: {
        ...unsafe,
        name: 'Old Name',
        slug: 'old-slug',
        extra: {
          ...unsafe,
          eas: { projectId: 'old-id', existing: true },
          featureFlag: 'enabled',
          newlyNested: unsafe,
        },
        ios: { ...unsafe, bundleIdentifier: 'old.id', supportsTablet: true },
        android: { package: 'old.id', permissions: ['CAMERA'] },
        updates: { enabled: true },
        plugins: ['expo-camera'],
      },
    })
  );

  const app = {
    id: '8a29adab-e8ac-4779-b897-9194c4b632c1',
    name: 'My App',
    slug: 'my-app',
    ownerAccount: { name: 'team-name' },
  };
  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(appJsonPath, 'utf8'));

  assert.equal(expo.name, 'My App');
  assert.equal(expo.slug, 'my-app');
  assert.equal(expo.scheme, 'myapp');
  assert.equal(expo.owner, 'team-name');
  assert.deepEqual(expo.extra.eas, { projectId: app.id, existing: true });
  assert.equal(expo.extra.featureFlag, 'enabled');
  assert.equal(expo.ios.bundleIdentifier, 'com.teamname.myapp');
  assert.equal(expo.ios.supportsTablet, true);
  assert.equal(expo.android.package, 'com.teamname.myapp');
  assert.deepEqual(expo.android.permissions, ['CAMERA']);
  assert.equal(expo.updates.enabled, true);
  assert.ok(new URL(expo.updates.url).pathname.endsWith(app.id));
  assert.equal(expo.runtimeVersion.policy, 'appVersion');
  assert.deepEqual(expo.plugins, ['expo-camera']);
  for (const value of [expo, expo.extra, expo.extra.newlyNested, expo.ios]) {
    assertSafeObject(value);
    assert.equal(value.retained, 'safe');
  }
});
