import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sha256File,
  sbomFileName,
  toCycloneDxComponents,
  buildCycloneDxDocument,
  assertCycloneDxDocument,
} from './mobile-sbom-cyclonedx.mjs';

const APP_VERSION = '1.0.12';
const APP_BUILD_VERSION = '2026092301';
const EAS_BUILD_ID = 'f1e2d3c4-0000-4000-8000-000000000000';
const ARTIFACT_SHA256 = 'a'.repeat(64);
const HASH_SOURCE = 'hash of the downloaded file that is submitted to the store';

const SOURCES = [
  { ecosystem: 'npm', source: 'pnpm-lock.yaml production closure of apps/mobile' },
  { ecosystem: 'cocoapods', source: 'Mach-O LC_LOAD_DYLIB and Payload/*.app/Frameworks' },
];

function stubComponents() {
  return toCycloneDxComponents([
    {
      ecosystem: 'npm',
      name: 'react',
      version: '19.2.6',
      purl: 'pkg:npm/react@19.2.6',
      hashes: [{ alg: 'SHA-256', content: 'b'.repeat(64) }],
    },
    {
      ecosystem: 'cocoapods',
      name: 'ExpoModulesCore',
      version: null,
      purl: 'pkg:cocoapods/ExpoModulesCore',
      extraProperties: [{ name: 'kilo:sbom:pod-source', value: 'artifact' }],
    },
  ]);
}

function buildArgs(platform, overrides = {}) {
  return {
    platform,
    appName: 'kilo-app',
    appVersion: APP_VERSION,
    appBuildVersion: APP_BUILD_VERSION,
    easBuildId: EAS_BUILD_ID,
    artifactName: platform === 'ios' ? 'app.ipa' : 'app.aab',
    artifactSha256: ARTIFACT_SHA256,
    components: stubComponents(),
    sources: SOURCES,
    ...overrides,
  };
}

function propertiesOf(doc) {
  return new Map(doc.metadata.properties.map(property => [property.name, property.value]));
}

test('buildCycloneDxDocument yields a valid linked document for ios and android', () => {
  for (const [platform, artifactName] of [
    ['ios', 'app.ipa'],
    ['android', 'app.aab'],
  ]) {
    const doc = buildCycloneDxDocument(buildArgs(platform));
    assert.doesNotThrow(() => assertCycloneDxDocument(doc));
    assert.equal(doc.bomFormat, 'CycloneDX');
    assert.equal(doc.version, 1);
    assert.match(doc.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(doc.metadata.component.type, 'application');
    assert.equal(doc.metadata.component.name, 'kilo-app');
    assert.equal(doc.metadata.component.version, APP_VERSION);
    assert.equal(doc.metadata.component['bom-ref'], `pkg:generic/kilo-app@${APP_VERSION}`);

    const properties = propertiesOf(doc);
    assert.equal(properties.get('kilo:sbom:platform'), platform);
    assert.equal(properties.get('kilo:sbom:app-version'), APP_VERSION);
    assert.equal(properties.get('kilo:sbom:build-number'), APP_BUILD_VERSION);
    assert.equal(properties.get('kilo:sbom:eas-build-id'), EAS_BUILD_ID);
    assert.equal(properties.get('kilo:sbom:artifact-sha256'), ARTIFACT_SHA256);
    assert.equal(properties.get('kilo:sbom:artifact-name'), artifactName);
    assert.equal(properties.get('kilo:sbom:artifact-sha256-source'), HASH_SOURCE);
    assert.equal(properties.get('kilo:sbom:source:npm'), SOURCES[0].source);
    assert.equal(properties.get('kilo:sbom:source:cocoapods'), SOURCES[1].source);
    assert.equal(doc.components.length, 2);
  }
});

test('sha256File matches the literal SHA-256 of the file bytes', () => {
  const work = mkdtempSync(join(tmpdir(), 'kilo-sbom-hash-'));
  try {
    const file = join(work, 'artifact.bin');
    writeFileSync(file, Buffer.from('kilo-app-sbom'));
    assert.equal(
      sha256File(file),
      '71509d88770ebf5cebf31b87fa61b544601489a39654ef57da9bf472879300bf'
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('sha256File fails with cannot hash when the file is unreadable', () => {
  assert.throws(() => sha256File('/nonexistent/kilo-app-artifact'), /cannot hash/);
});

test('buildCycloneDxDocument rejects a wrong or missing artifact hash', () => {
  assert.throws(
    () => buildCycloneDxDocument(buildArgs('ios', { artifactSha256: 'abc' })),
    /artifactSha256/
  );
  assert.throws(
    () => buildCycloneDxDocument(buildArgs('ios', { artifactSha256: 'A'.repeat(64) })),
    /artifactSha256/
  );
  const missing = buildArgs('ios');
  delete missing.artifactSha256;
  assert.throws(() => buildCycloneDxDocument(missing), /artifactSha256/);
});

test('buildCycloneDxDocument rejects invalid platform and empty build metadata', () => {
  assert.throws(() => buildCycloneDxDocument(buildArgs('windows')), /platform/);
  assert.throws(() => buildCycloneDxDocument(buildArgs('ios', { appVersion: '' })), /appVersion/);
  assert.throws(
    () => buildCycloneDxDocument(buildArgs('ios', { appBuildVersion: '' })),
    /appBuildVersion/
  );
  assert.throws(() => buildCycloneDxDocument(buildArgs('ios', { easBuildId: '' })), /easBuildId/);
  assert.throws(
    () => buildCycloneDxDocument(buildArgs('ios', { components: undefined })),
    /components/
  );
});

test('assertCycloneDxDocument rejects a document missing linkage', () => {
  const doc = buildCycloneDxDocument(buildArgs('ios'));
  assert.throws(() => assertCycloneDxDocument({ ...doc, bomFormat: 'SPDX' }), /bomFormat/);
  assert.throws(
    () => assertCycloneDxDocument({ ...doc, metadata: { ...doc.metadata, component: undefined } }),
    /metadata\.component/
  );
  const unlinked = buildCycloneDxDocument(buildArgs('ios', { sources: SOURCES }));
  unlinked.metadata.properties = unlinked.metadata.properties.filter(
    property => property.name !== 'kilo:sbom:eas-build-id'
  );
  assert.throws(() => assertCycloneDxDocument(unlinked), /kilo:sbom:eas-build-id/);
});

test('sbomFileName carries the platform and the app version', () => {
  assert.equal(
    sbomFileName({ platform: 'ios', appVersion: '1.0.12', appBuildVersion: '42' }),
    'kilo-app-ios-1.0.12-build42.cyclonedx.json'
  );
  assert.equal(
    sbomFileName({ platform: 'android', appVersion: '1.0.12', appBuildVersion: '42' }),
    'kilo-app-android-1.0.12-build42.cyclonedx.json'
  );
  assert.throws(
    () => sbomFileName({ platform: 'windows', appVersion: '1.0.12', appBuildVersion: '42' }),
    /platform/
  );
  assert.throws(
    () => sbomFileName({ platform: 'ios', appVersion: '', appBuildVersion: '42' }),
    /appVersion/
  );
  assert.throws(
    () => sbomFileName({ platform: 'ios', appVersion: '1.0.12', appBuildVersion: '' }),
    /appBuildVersion/
  );
});

test('toCycloneDxComponents sets ecosystem, purl and unique bom-refs', () => {
  const components = toCycloneDxComponents([
    { ecosystem: 'npm', name: 'react', version: '19.2.6', purl: 'pkg:npm/react@19.2.6' },
    { ecosystem: 'npm', name: 'react', version: '19.2.6', purl: 'pkg:npm/react@19.2.6' },
    {
      ecosystem: 'maven',
      name: 'okhttp',
      version: '4.12.0',
      purl: 'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0',
    },
    {
      ecosystem: 'native-library',
      name: 'libhermes',
      version: null,
      purl: 'pkg:generic/libhermes',
    },
  ]);

  assert.equal(components[0].type, 'library');
  assert.equal(components[0].scope, 'required');
  assert.equal(components[0].properties[0].name, 'kilo:sbom:ecosystem');
  assert.equal(components[0].properties[0].value, 'npm');
  assert.equal(components[2].properties[0].value, 'maven');
  assert.equal(components[3].properties[0].value, 'native-library');
  assert.equal(components[0].purl, 'pkg:npm/react@19.2.6');
  assert.equal(components[0]['bom-ref'], 'pkg:npm/react@19.2.6');
  assert.equal(components[1]['bom-ref'], 'pkg:npm/react@19.2.6#2');
  assert.equal(components[2]['bom-ref'], 'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0');
  assert.equal('version' in components[3], false);
  assert.deepEqual(components[0].hashes, []);

  const refs = components.map(component => component['bom-ref']);
  assert.equal(new Set(refs).size, refs.length);
});

test('toCycloneDxComponents keeps extra properties and supplied hashes', () => {
  const [component] = toCycloneDxComponents([
    {
      ecosystem: 'maven',
      name: 'okhttp',
      version: '4.12.0',
      purl: 'pkg:maven/com.squareup.okhttp3/okhttp@4.12.0',
      hashes: [{ alg: 'SHA-256', content: 'c'.repeat(64) }],
      extraProperties: [{ name: 'kilo:sbom:maven-group', value: 'com.squareup.okhttp3' }],
    },
  ]);
  assert.deepEqual(component.properties, [
    { name: 'kilo:sbom:ecosystem', value: 'maven' },
    { name: 'kilo:sbom:maven-group', value: 'com.squareup.okhttp3' },
  ]);
  assert.deepEqual(component.hashes, [{ alg: 'SHA-256', content: 'c'.repeat(64) }]);
  assert.equal(component.version, '4.12.0');
});
