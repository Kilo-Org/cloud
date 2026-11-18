import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bundledComponents, readModuleRecords } from './kilo-extension-sbom.mjs';

/** A fake installed package with a manifest and one source file. */
function writePackage(dir, name, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(dir, 'index.js'), '');
  return dir;
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A tree with plain, scoped and pnpm-layout packages plus two record files. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-extension-sbom-'));
  const nodeModules = join(dir, 'node_modules');
  const plain = writePackage(join(nodeModules, 'plain'), 'plain', '1.0.0');
  const scoped = writePackage(join(nodeModules, '@scope/scoped'), '@scope/scoped', '2.0.0');
  const pnpmLayout = writePackage(
    join(nodeModules, '.pnpm/pnpm-layout@3.0.0/node_modules/pnpm-layout'),
    'pnpm-layout',
    '3.0.0'
  );
  // Installed but rendered nothing: the build recorded no bytes for it.
  writePackage(join(nodeModules, 'zero'), 'zero', '0.1.0');
  writeFileSync(join(plain, 'font.woff2'), 'font');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), '');

  const records = join(dir, 'records');
  writeJson(join(records, 'a.json'), {
    modules: [
      { id: join(plain, 'index.js'), bytes: 100 },
      { id: `${join(scoped, 'index.js')}?v=1`, bytes: 50 },
      { id: '\0virtual:module', bytes: 999 },
      { id: join(nodeModules, 'gone', 'index.js'), bytes: 10 },
      { id: join(dir, 'src', 'app.ts'), bytes: 7 },
    ],
    assets: [
      { file: join(plain, 'font.woff2'), bytes: 25 },
      { file: join(dir, 'public', 'icon.png'), bytes: 3 },
    ],
  });
  writeJson(join(records, 'b.json'), {
    modules: [
      { id: join(plain, 'index.js'), bytes: 20 },
      { id: join(pnpmLayout, 'index.js'), bytes: 40 },
    ],
    assets: [{ file: join(plain, 'font.woff2'), bytes: 5 }],
  });

  const digest = Buffer.from('digest').toString('base64');
  const lockfile = {
    packages: { 'plain@1.0.0': { resolution: { integrity: `sha512-${digest}` } } },
  };
  return { lockfile, records };
}

test('bundledComponents sums one package across records, assets and query ids', () => {
  const { records, lockfile } = fixture();
  const components = bundledComponents({ records: readModuleRecords(records), lockfile });

  assert.deepEqual(components, [
    {
      ecosystem: 'npm',
      name: '@scope/scoped',
      version: '2.0.0',
      purl: 'pkg:npm/%40scope/scoped@2.0.0',
      extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: '50' }],
    },
    {
      ecosystem: 'npm',
      name: 'plain',
      version: '1.0.0',
      purl: 'pkg:npm/plain@1.0.0',
      hashes: [
        {
          alg: 'SHA-512',
          content: Buffer.from('digest').toString('hex'),
        },
      ],
      extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: '150' }],
    },
    {
      ecosystem: 'npm',
      name: 'pnpm-layout',
      version: '3.0.0',
      purl: 'pkg:npm/pnpm-layout@3.0.0',
      extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: '40' }],
    },
  ]);
});

test('readModuleRecords rejects a record file without a modules and an assets array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-extension-sbom-bad-'));
  writeJson(join(dir, 'a.json'), { modules: [{ id: 'x', bytes: 1 }] });

  assert.throws(() => readModuleRecords(dir), /not a module record/);
});

test('readModuleRecords rejects a module entry without an integer byte count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-extension-sbom-bytes-'));
  writeJson(join(dir, 'a.json'), { modules: [{ id: 'x', bytes: '1' }], assets: [] });

  assert.throws(() => readModuleRecords(dir), /module entry must be/);
});

test('readModuleRecords rejects a directory without record files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-extension-sbom-empty-'));

  assert.throws(() => readModuleRecords(dir), /holds no \*\.json module record/);
});
