import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const mobilePackagePath = new URL('../apps/mobile/package.json', import.meta.url);
const mobileRequire = createRequire(mobilePackagePath);
const easPackagePath = mobileRequire.resolve('eas-cli/package.json');
const easRequire = createRequire(easPackagePath);
const { generateAppConfigAsync } = easRequire('./build/commandUtils/new/projectFiles.js');

const app = {
  id: 'c8c12e41-9888-46d4-9f73-e16191991973',
  name: 'Example App',
  slug: 'example-app',
  ownerAccount: { name: 'example-owner' },
};

async function generateConfig(expo) {
  const projectDir = await mkdtemp(join(tmpdir(), 'eas-app-config-'));
  try {
    const appJsonPath = join(projectDir, 'app.json');
    await writeFile(appJsonPath, JSON.stringify({ expo }));
    await generateAppConfigAsync(projectDir, app);
    return JSON.parse(await readFile(appJsonPath, 'utf8')).expo;
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

test('installed EAS CLI resolves its patched merge dependency', async () => {
  const mobilePackage = JSON.parse(await readFile(mobilePackagePath, 'utf8'));
  const easPackage = JSON.parse(await readFile(easPackagePath, 'utf8'));
  const mergeEntry = easRequire.resolve('ts-deepmerge');
  const mergePackage = JSON.parse(
    await readFile(resolve(dirname(mergeEntry), '../package.json'), 'utf8')
  );

  assert.equal(mobilePackage.devDependencies['eas-cli'], '24.13.0');
  assert.equal(easPackage.version, '24.13.0');
  assert.equal(mergePackage.version, '8.0.0');
});

test('EAS app config generation preserves nested values and arrays with generated precedence', async () => {
  const config = await generateConfig({
    name: 'Old Name',
    slug: 'old-slug',
    scheme: 'old-scheme',
    owner: 'old-owner',
    extra: { eas: { projectId: 'old-id', retained: true }, feature: { enabled: true } },
    updates: { url: 'https://old.invalid', fallbackToCacheTimeout: 5000 },
    runtimeVersion: { policy: 'sdkVersion', retained: 'runtime' },
    ios: { bundleIdentifier: 'old.bundle', supportsTablet: true },
    android: { package: 'old.package', permissions: ['CAMERA', 'NOTIFICATIONS'] },
    plugins: ['expo-router', ['example-plugin', { enabled: true }]],
  });

  assert.match(config.updates.url, new RegExp(`${app.id}$`));
  assert.deepEqual(config, {
    name: 'Example App',
    slug: 'example-app',
    scheme: 'exampleapp',
    owner: 'example-owner',
    extra: {
      eas: { projectId: app.id, retained: true },
      feature: { enabled: true },
    },
    updates: { url: config.updates.url, fallbackToCacheTimeout: 5000 },
    runtimeVersion: { policy: 'appVersion', retained: 'runtime' },
    ios: { bundleIdentifier: 'com.exampleowner.exampleapp', supportsTablet: true },
    android: {
      package: 'com.exampleowner.exampleapp',
      permissions: ['CAMERA', 'NOTIFICATIONS'],
    },
    plugins: ['expo-router', ['example-plugin', { enabled: true }]],
  });
});

test('EAS app config generation filters advisory prototype-method payloads', async () => {
  const payload = JSON.parse(
    '{"toString":"<img src=x onerror=alert(1)>","valueOf":1,"hasOwnProperty":false,"isPrototypeOf":false,"propertyIsEnumerable":false,"toLocaleString":"bad","safe":"retained"}'
  );
  const config = await generateConfig({ ...payload, extra: { nested: payload, eas: payload } });

  for (const value of [config, config.extra.nested, config.extra.eas]) {
    for (const key of [
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
    ]) {
      assert.equal(Object.hasOwn(value, key), false, `${key} must not override a prototype method`);
    }
    assert.equal(String(value), '[object Object]');
    assert.equal(value.safe, 'retained');
  }
  assert.equal(config.extra.eas.projectId, app.id);
});
