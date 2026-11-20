import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const mobileManifestUrl = new URL('../apps/mobile/package.json', import.meta.url);
const mobileRequire = createRequire(mobileManifestUrl);
const easManifestPath = mobileRequire.resolve('eas-cli/package.json');
const easRequire = createRequire(easManifestPath);
const deepMergePath = easRequire.resolve('ts-deepmerge');
const { generateAppConfigAsync } = easRequire('./build/commandUtils/new/projectFiles.js');

const app = {
  id: '8a29adab-e8ac-4779-b897-9194c4b632c1',
  name: 'My Cool App',
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

function unsafeConfig() {
  return JSON.parse(`{
    "__proto__": {"easCliConfigPolluted": true},
    "constructor": {"prototype": {"easCliConfigPolluted": true}},
    "prototype": 0,
    "toString": "blocked",
    "valueOf": 0,
    "hasOwnProperty": false,
    "isPrototypeOf": null,
    "propertyIsEnumerable": [],
    "toLocaleString": {},
    "retained": "safe"
  }`);
}

async function createProject(t, contents) {
  const projectDir = await mkdtemp(join(tmpdir(), 'eas-cli-config-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const configPath = join(projectDir, 'app.json');
  await writeFile(configPath, contents);
  return { projectDir, configPath };
}

test('mobile EAS resolves the patched ts-deepmerge version', () => {
  const mobileManifest = JSON.parse(readFileSync(mobileManifestUrl, 'utf8'));
  const easManifest = JSON.parse(readFileSync(easManifestPath, 'utf8'));
  const deepMergeManifest = JSON.parse(
    readFileSync(join(dirname(deepMergePath), '..', 'package.json'), 'utf8')
  );

  assert.equal(mobileManifest.devDependencies['eas-cli'], '27.9.0');
  assert.equal(easManifest.version, '27.9.0');
  assert.equal(deepMergeManifest.version, '8.0.0');
  assert.equal(typeof easRequire('ts-deepmerge').merge, 'function');
});

test('deep merge preserves ordinary nested values and unique array items', () => {
  const { merge } = easRequire('ts-deepmerge');
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

test('EAS generates app config while preserving existing settings', async t => {
  const plugins = ['expo-camera', ['expo-build-properties', { ios: { deploymentTarget: '16.0' } }]];
  const { projectDir, configPath } = await createProject(
    t,
    JSON.stringify({
      expo: {
        name: 'Old Name',
        slug: 'old-slug',
        scheme: 'oldscheme',
        owner: 'old-owner',
        version: '1.2.3',
        extra: {
          eas: { projectId: 'old-id', retained: true },
          featureFlag: false,
          nested: { value: null },
        },
        ios: { bundleIdentifier: 'old.id', supportsTablet: true },
        android: { package: 'old.id', permissions: ['CAMERA', 'NOTIFICATIONS'] },
        updates: { url: 'https://old.example.test', enabled: true },
        runtimeVersion: { policy: 'nativeVersion', retained: true },
        plugins,
      },
    })
  );

  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(configPath, 'utf8'));
  const updateUrl = new URL(expo.updates.url);
  assert.ok(updateUrl.pathname.endsWith(`/${app.id}`));
  assert.deepEqual(expo, {
    name: app.name,
    slug: app.slug,
    scheme: 'mycoolapp',
    owner: app.ownerAccount.name,
    version: '1.2.3',
    extra: {
      eas: { projectId: app.id, retained: true },
      featureFlag: false,
      nested: { value: null },
    },
    ios: { bundleIdentifier: 'com.teamname.myapp', supportsTablet: true },
    android: { package: 'com.teamname.myapp', permissions: ['CAMERA', 'NOTIFICATIONS'] },
    updates: { url: updateUrl.href, enabled: true },
    runtimeVersion: { policy: 'appVersion', retained: true },
    plugins,
  });
});

test('EAS filters unsafe prototype keys in root and nested config objects', async t => {
  assert.equal(Object.hasOwn(Object.prototype, 'easCliConfigPolluted'), false);
  t.after(() => {
    delete Object.prototype.easCliConfigPolluted;
  });
  const unsafe = unsafeConfig();
  const { projectDir, configPath } = await createProject(
    t,
    JSON.stringify({
      expo: {
        ...unsafe,
        extra: {
          ...unsafe,
          eas: { ...unsafe, projectId: 'old-id' },
          introduced: { ...unsafe, nested: unsafe },
        },
        ios: { ...unsafe, supportsTablet: true },
      },
    })
  );

  await generateAppConfigAsync(projectDir, app);
  const { expo } = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(expo.extra.eas.projectId, app.id);
  assert.equal(expo.ios.supportsTablet, true);
  for (const [path, value] of Object.entries({
    expo,
    extra: expo.extra,
    eas: expo.extra.eas,
    introduced: expo.extra.introduced,
    nested: expo.extra.introduced.nested,
    ios: expo.ios,
  })) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, path);
    assert.equal(String(value), '[object Object]', path);
    assert.equal('' + value, '[object Object]', path);
    assert.equal([value].join(), '[object Object]', path);
    for (const key of unsafeKeys) {
      assert.equal(Object.hasOwn(value, key), false, `${path}.${key}`);
    }
    assert.equal(value.retained, 'safe', path);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'easCliConfigPolluted'), false);
});

test('EAS generates a config when app.json has no expo property', async t => {
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
