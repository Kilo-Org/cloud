import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const mobileManifestUrl = new URL('../apps/mobile/package.json', import.meta.url);
const mobileManifest = JSON.parse(readFileSync(mobileManifestUrl, 'utf8'));
const mobileRequire = createRequire(mobileManifestUrl);
const easManifestPath = mobileRequire.resolve('eas-cli/package.json');
const easManifest = JSON.parse(readFileSync(easManifestPath, 'utf8'));
const easRequire = createRequire(easManifestPath);
const deepMergePath = easRequire.resolve('ts-deepmerge');
const deepMergeManifest = JSON.parse(
  readFileSync(join(dirname(deepMergePath), '..', 'package.json'), 'utf8')
);
const { merge } = easRequire('ts-deepmerge');
const { generateAppConfigAsync } = easRequire('./build/commandUtils/new/projectFiles.js');

const app = {
  id: '8a29adab-e8ac-4779-b897-9194c4b632c1',
  name: 'My App',
  slug: 'my-app',
  ownerAccount: { name: 'team-name' },
};

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
  return Object.fromEntries([
    ['__proto__', { easMergePolluted: true }],
    ['constructor', { prototype: { easMergePolluted: true } }],
    ...unsafeKeys.filter(key => key !== '__proto__' && key !== 'constructor').map(key => [key, 0]),
    ['retained', 'safe'],
  ]);
}

function assertSafeObject(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of unsafeKeys) {
    assert.equal(Object.hasOwn(value, key), false, key);
  }
  assert.equal(String(value), '[object Object]');
}

async function createProject(t, contents) {
  const projectDir = await mkdtemp(join(tmpdir(), 'eas-config-test-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const configPath = join(projectDir, 'app.json');
  await writeFile(configPath, contents);
  return { projectDir, configPath };
}

test('mobile EAS resolves ts-deepmerge 8 through its named export', () => {
  assert.equal(mobileManifest.devDependencies['eas-cli'], '24.13.0');
  assert.equal(easManifest.version, '24.13.0');
  assert.equal(deepMergeManifest.version, '8.0.0');
  assert.equal(typeof merge, 'function');
});

test('default merge preserves nested values, overrides, and unique array items', () => {
  const base = {
    plugins: ['camera', 'shared', 'camera'],
    extra: { eas: { projectId: 'old-id', retained: true }, mode: 'old' },
    flag: 'old',
  };
  const update = {
    plugins: ['shared', 'notifications'],
    extra: { eas: { projectId: 'new-id' }, mode: 'new' },
    flag: 'new',
  };
  const originalBase = structuredClone(base);
  const originalUpdate = structuredClone(update);

  assert.deepEqual(merge(base, update), {
    plugins: ['camera', 'shared', 'notifications'],
    extra: { eas: { projectId: 'new-id', retained: true }, mode: 'new' },
    flag: 'new',
  });
  assert.deepEqual(base, originalBase);
  assert.deepEqual(update, originalUpdate);
});

test('merge removes unsafe keys from root, existing, and newly introduced objects', () => {
  const unsafe = unsafeObject();
  const base = { ...unsafe, existing: { before: 'existing' }, introduced: unsafe };
  const update = { existing: { ...unsafe, after: 'new' } };
  const originalBase = structuredClone(base);
  const result = merge(base, update);

  assert.deepEqual(result, {
    retained: 'safe',
    existing: { before: 'existing', retained: 'safe', after: 'new' },
    introduced: { retained: 'safe' },
  });
  for (const value of [result, result.existing, result.introduced]) {
    assertSafeObject(value);
  }
  assert.notEqual(result.introduced, base.introduced);
  assert.equal(Object.hasOwn(Object.prototype, 'easMergePolluted'), false);
  assert.deepEqual(base, originalBase);
});

test('EAS generates app config without losing existing settings', async t => {
  const { projectDir, configPath } = await createProject(
    t,
    JSON.stringify({
      expo: {
        name: 'Old Name',
        slug: 'old-slug',
        extra: { eas: { projectId: 'old-id', existing: true }, featureFlag: 'enabled' },
        ios: { bundleIdentifier: 'old.id', supportsTablet: true },
        android: { package: 'old.id', permissions: ['CAMERA'] },
        updates: { enabled: true },
        plugins: ['expo-camera'],
      },
    })
  );

  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(configPath, 'utf8'));

  assert.equal(expo.name, app.name);
  assert.equal(expo.slug, app.slug);
  assert.equal(expo.scheme, 'myapp');
  assert.equal(expo.owner, app.ownerAccount.name);
  assert.deepEqual(expo.extra, {
    eas: { projectId: app.id, existing: true },
    featureFlag: 'enabled',
  });
  assert.deepEqual(expo.ios, { bundleIdentifier: 'com.teamname.myapp', supportsTablet: true });
  assert.deepEqual(expo.android, { package: 'com.teamname.myapp', permissions: ['CAMERA'] });
  assert.equal(expo.updates.enabled, true);
  assert.ok(new URL(expo.updates.url).pathname.endsWith(`/${app.id}`));
  assert.deepEqual(expo.runtimeVersion, { policy: 'appVersion' });
  assert.deepEqual(expo.plugins, ['expo-camera']);
});

test('EAS filters unsafe config keys even in newly introduced objects', async t => {
  const unsafe = unsafeObject();
  const { projectDir, configPath } = await createProject(
    t,
    JSON.stringify({
      expo: {
        ...unsafe,
        extra: { ...unsafe, eas: { projectId: 'old-id' }, introduced: unsafe },
        ios: { ...unsafe, supportsTablet: true },
      },
    })
  );

  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(configPath, 'utf8'));

  assert.deepEqual(expo.extra.eas, { projectId: app.id });
  assert.equal(expo.ios.supportsTablet, true);
  for (const value of [expo, expo.extra, expo.extra.introduced, expo.ios]) {
    assertSafeObject(value);
    assert.equal(value.retained, 'safe');
  }
  assert.equal(Object.hasOwn(Object.prototype, 'easMergePolluted'), false);
});

test('EAS generates config when the expo property is missing', async t => {
  const { projectDir, configPath } = await createProject(t, '{}');

  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(configPath, 'utf8'));

  assert.equal(expo.name, app.name);
  assert.equal(expo.slug, app.slug);
  assert.equal(expo.extra.eas.projectId, app.id);
  assert.equal(expo.ios.bundleIdentifier, 'com.teamname.myapp');
  assert.equal(expo.android.package, 'com.teamname.myapp');
});

for (const { description, contents, error } of [
  { description: 'malformed JSON', contents: '{"expo":', error: SyntaxError },
  { description: 'a null expo config', contents: '{"expo":null}', error: TypeError },
  { description: 'an array expo config', contents: '{"expo":[]}', error: TypeError },
]) {
  test(`EAS rejects ${description} without rewriting app.json`, async t => {
    const { projectDir, configPath } = await createProject(t, contents);

    await assert.rejects(generateAppConfigAsync(projectDir, app), error);
    assert.equal(await readFile(configPath, 'utf8'), contents);
  });
}
