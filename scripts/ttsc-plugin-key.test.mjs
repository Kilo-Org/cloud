import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { dump, load } from 'js-yaml';

import { files, pluginKey } from './ttsc-plugin-key.mjs';

const manifest = 'packages/harness-sdk/package.json';
const tsconfig = 'packages/harness-sdk/tsconfig.json';

// A root holding the files the key hashes, copied from this repository, so the
// file list itself is under test: hashing the harness SDK manifest or its
// tsconfig would make the unchanged-key assertions below fail. The root carries
// those two files anyway, so the tests can edit them.
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ttsc-plugin-key-'));
  const fixtures = [...files, manifest, tsconfig, 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  for (const path of fixtures) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  cpSync(new URL('../patches', import.meta.url), join(root, 'patches'), { recursive: true });
  return root;
}

// The edited case starts from a copy of the same root, so its only difference is
// the edit under test rather than a second serialisation of the inputs.
function edited(root, edit) {
  const copy = mkdtempSync(join(tmpdir(), 'ttsc-plugin-key-'));
  cpSync(root, copy, { recursive: true });
  edit(copy);
  return copy;
}

function updateJson(root, path, edit) {
  const location = join(root, path);
  const document = JSON.parse(readFileSync(location, 'utf8'));
  edit(document);
  writeFileSync(location, `${JSON.stringify(document, null, 2)}\n`);
}

function updateLockfile(root, edit) {
  const location = join(root, 'pnpm-lock.yaml');
  const lockfile = load(readFileSync(location, 'utf8'));
  edit(lockfile);
  writeFileSync(location, dump(lockfile, { lineWidth: -1 }));
}

// A closure failure widens the key to the whole lockfile, which would make the
// unchanged-key assertions pass for the wrong reason.
function keyOf(root) {
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  try {
    return { key: pluginKey(root), errors };
  } finally {
    console.error = original;
  }
}

test('a dependency outside the plugin closure keeps the key', () => {
  const before = repository();
  const baseline = keyOf(before);
  assert.deepEqual(baseline.errors, [], 'the real lockfile resolves the plugin closure');

  const manifestOnly = edited(before, root => {
    updateJson(root, manifest, document => {
      document.devDependencies['left-pad'] = '1.3.0';
    });
  });
  assert.equal(keyOf(manifestOnly).key, baseline.key);

  const installed = edited(manifestOnly, root => {
    updateLockfile(root, lockfile => {
      lockfile.importers['packages/harness-sdk'].devDependencies['left-pad'] = {
        specifier: '1.3.0',
        version: '1.3.0',
      };
      lockfile.packages['left-pad@1.3.0'] = { resolution: { integrity: 'left-pad-integrity' } };
      lockfile.snapshots['left-pad@1.3.0'] = {};
    });
  });
  assert.equal(keyOf(installed).key, baseline.key);
});

test('a harness SDK compilerOptions change keeps the key', () => {
  const before = repository();
  const changed = edited(before, root => {
    updateJson(root, tsconfig, document => {
      document.compilerOptions.target = 'es2022';
      document.compilerOptions.strict = false;
    });
  });

  assert.equal(keyOf(changed).key, keyOf(before).key);
});

test('moving a plugin package moves the key', () => {
  const before = repository();
  const changed = edited(before, root => {
    updateJson(root, manifest, document => {
      document.dependencies.typia = '15.2.0';
    });
    updateLockfile(root, lockfile => {
      lockfile.importers['packages/harness-sdk'].dependencies.typia = {
        specifier: '15.2.0',
        version: '15.2.0(ttsc@0.33.0)',
      };
      lockfile.packages['typia@15.2.0'] = { resolution: { integrity: 'typia-15.2.0-integrity' } };
      lockfile.snapshots['typia@15.2.0(ttsc@0.33.0)'] = {
        optionalDependencies: { ttsc: '0.33.0' },
      };
    });
  });

  assert.notEqual(keyOf(changed).key, keyOf(before).key);
});
