import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

// pnpm applies a versionless `patchedDependencies` selector to whatever version
// resolves, so a dependency bump reuses an old patch silently. Every entry names
// the version it was written against and keeps its patch file under the same
// `name@version`, so a bump leaves the patch behind visibly instead of widening
// it to every later release.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');

type PatchEntry = { selector: string; patchPath: string };

type Lockfile = {
  patchedDependencies?: Record<string, string>;
  packages?: Record<string, unknown>;
};

function readPatchedDependencies(filePath: string): PatchEntry[] {
  const document = load(fs.readFileSync(filePath, 'utf8')) as {
    patchedDependencies?: Record<string, string>;
  };
  return Object.entries(document.patchedDependencies ?? {}).map(([selector, patchPath]) => ({
    selector,
    patchPath,
  }));
}

function readLockfile(): Lockfile {
  return load(fs.readFileSync(lockfilePath, 'utf8')) as Lockfile;
}

function entryProblems({ selector, patchPath }: PatchEntry): string[] {
  const problems: string[] = [];
  const version = selector.slice(selector.lastIndexOf('@') + 1);
  if (!/^\d/.test(version)) {
    problems.push(`${selector} must name the version it patches, as in ${selector}@1.2.3`);
  }
  const expected = `patches/${selector.replaceAll('/', '+')}.patch`;
  if (patchPath !== expected)
    problems.push(`${selector} must map to ${expected}, not ${patchPath}`);
  return problems;
}

test('pnpm-workspace.yaml declares versioned patchedDependencies entries', () => {
  const entries = readPatchedDependencies(workspacePath);
  assert.ok(entries.length > 0, 'pnpm-workspace.yaml must declare patchedDependencies');
  assert.deepEqual(entries.flatMap(entryProblems), []);
});

test('every declared patch file exists', () => {
  for (const { selector, patchPath } of readPatchedDependencies(workspacePath)) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, patchPath)),
      `${selector} must point at an existing ${patchPath}`
    );
  }
});

test('the lockfile records the same patch selectors as the workspace', () => {
  const selectors = readPatchedDependencies(workspacePath)
    .map(({ selector }) => selector)
    .sort();
  assert.deepEqual(Object.keys(readLockfile().patchedDependencies ?? {}).sort(), selectors);
});

test('every pinned version is the one the lockfile resolves', () => {
  const selectors = readPatchedDependencies(workspacePath).map(({ selector }) => selector);
  const packages = readLockfile().packages ?? {};
  assert.deepEqual(
    selectors.filter(selector => !Object.hasOwn(packages, selector)),
    []
  );

  // A bump that leaves the selector behind resolves nothing, so pnpm stops
  // applying the patch instead of failing: the stale selector must be reported.
  const bumped: Record<string, unknown> = { ...packages };
  bumped['expo-server-sdk@6.2.0'] = bumped['expo-server-sdk@6.1.0'];
  delete bumped['expo-server-sdk@6.1.0'];
  assert.deepEqual(
    selectors.filter(selector => !Object.hasOwn(bumped, selector)),
    ['expo-server-sdk@6.1.0']
  );
});

test('the version check rejects a selector without a version', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patched-dependencies-'));
  try {
    const filePath = path.join(directory, 'pnpm-workspace.yaml');
    fs.writeFileSync(
      filePath,
      'patchedDependencies:\n  expo-server-sdk: patches/expo-server-sdk.patch\n'
    );
    assert.deepEqual(readPatchedDependencies(filePath).flatMap(entryProblems), [
      'expo-server-sdk must name the version it patches, as in expo-server-sdk@1.2.3',
    ]);

    fs.writeFileSync(
      filePath,
      'patchedDependencies:\n  expo-server-sdk@6.1.0: patches/expo-server-sdk@6.1.0.patch\n'
    );
    assert.deepEqual(readPatchedDependencies(filePath).flatMap(entryProblems), []);

    fs.writeFileSync(
      filePath,
      'patchedDependencies:\n  expo-server-sdk@6.1.0: patches/expo-server-sdk.patch\n'
    );
    assert.deepEqual(readPatchedDependencies(filePath).flatMap(entryProblems), [
      'expo-server-sdk@6.1.0 must map to patches/expo-server-sdk@6.1.0.patch, not patches/expo-server-sdk.patch',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
