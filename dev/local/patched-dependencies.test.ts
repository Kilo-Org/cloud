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

type WorkspaceDocument = {
  entries: PatchEntry[];
  catalog: Record<string, string>;
  overrides: Record<string, string>;
  minimumReleaseAgeExclude: string[];
};

type Lockfile = {
  patchedDependencies?: Record<string, string>;
  packages?: Record<string, unknown>;
};

function readWorkspaceDocument(filePath: string): WorkspaceDocument {
  const document = load(fs.readFileSync(filePath, 'utf8')) as {
    patchedDependencies?: Record<string, string>;
    catalog?: Record<string, string>;
    overrides?: Record<string, string>;
    minimumReleaseAgeExclude?: string[];
  };
  return {
    entries: Object.entries(document.patchedDependencies ?? {}).map(([selector, patchPath]) => ({
      selector,
      patchPath,
    })),
    catalog: document.catalog ?? {},
    overrides: document.overrides ?? {},
    minimumReleaseAgeExclude: document.minimumReleaseAgeExclude ?? [],
  };
}

function readPatchedDependencies(filePath: string): PatchEntry[] {
  return readWorkspaceDocument(filePath).entries;
}

function readLockfile(): Lockfile {
  return load(fs.readFileSync(lockfilePath, 'utf8')) as Lockfile;
}

function resolved(packages: Record<string, unknown>, selector: string): boolean {
  return Object.keys(packages).some(key => key === selector || key.startsWith(`${selector}(`));
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

// A patch key names the version it was written against, and the same file
// records that version for the same package in other places. A bump that moves
// one record and not the others reuses a stale patch or leaves a second copy of
// the package, so compare them here instead of trusting the notes beside them.
type VersionPair = {
  selector: string;
  packageName: string;
  patchVersion: string;
  source: string;
  recordedVersion: string;
};

type VersionCheck = {
  pairs: VersionPair[];
  // A mirror that states a range or an `npm:` alias still couples the two
  // records, so report it instead of quietly leaving the coupling unchecked.
  uncomparable: string[];
};

const plainVersion = /^\d+\.\d+\.\d+/;

function versionCheck({
  entries,
  catalog,
  overrides,
  minimumReleaseAgeExclude,
}: WorkspaceDocument): VersionCheck {
  const pairs: VersionPair[] = [];
  const uncomparable: string[] = [];
  for (const { selector } of entries) {
    const at = selector.lastIndexOf('@');
    const packageName = selector.slice(0, at);
    const patchVersion = selector.slice(at + 1);
    const mirrors: { source: string; value: string }[] = [];
    if (catalog[packageName] !== undefined)
      mirrors.push({ source: 'catalog', value: catalog[packageName] });
    if (overrides[packageName] !== undefined)
      mirrors.push({ source: 'overrides', value: overrides[packageName] });
    for (const exclude of minimumReleaseAgeExclude) {
      // An entry without a version exempts every release and names no pin to
      // compare, so only the `name@version` form takes part.
      const excludeAt = exclude.lastIndexOf('@');
      if (excludeAt <= 0 || exclude.slice(0, excludeAt) !== packageName) continue;
      mirrors.push({ source: 'minimumReleaseAgeExclude', value: exclude.slice(excludeAt + 1) });
    }
    for (const { source, value } of mirrors) {
      // `catalog:` takes the catalog pin for the same package, so compare that.
      const recordedVersion = value === 'catalog:' ? catalog[packageName] : value;
      if (recordedVersion === undefined || !plainVersion.test(recordedVersion)) {
        uncomparable.push(
          `${selector} has ${source === 'overrides' ? 'an' : 'a'} ${source} value '${value}' that states no single version, so the two cannot be compared`
        );
        continue;
      }
      pairs.push({ selector, packageName, patchVersion, source, recordedVersion });
    }
  }
  return { pairs, uncomparable };
}

function versionMismatches(pairs: VersionPair[]): string[] {
  return pairs
    .filter(({ patchVersion, recordedVersion }) => patchVersion !== recordedVersion)
    .map(
      ({ selector, patchVersion, source, recordedVersion }) =>
        `${selector} names ${patchVersion}, but ${source} records ${recordedVersion}`
    );
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
    selectors.filter(selector => !resolved(packages, selector)),
    []
  );
});

test('the resolved-version check accepts peer suffixes and reports a stale selector', () => {
  // `packages` records bare keys today, while `snapshots` records peer-suffixed
  // ones such as `react-native@0.86.3(patch_hash=…)(...)`. Accepting either keeps
  // the check correct if pnpm moves the entry between sections.
  const packages = {
    'fixture-sdk@2.0.0': {},
    '@scope/peer-sdk@3.1.0(peer@1.0.0)': {},
  };
  assert.deepEqual(
    ['fixture-sdk@2.0.0', '@scope/peer-sdk@3.1.0'].filter(
      selector => !resolved(packages, selector)
    ),
    []
  );
  assert.deepEqual(
    ['@scope/peer-sdk@3.1.0', 'fixture-sdk@1.9.0'].filter(
      selector => !resolved(packages, selector)
    ),
    ['fixture-sdk@1.9.0']
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

test('every patch key agrees with the version the workspace records elsewhere', () => {
  const { pairs, uncomparable } = versionCheck(readWorkspaceDocument(workspacePath));
  // Each of these keys mirrors a version the file records elsewhere, so losing
  // the mirroring entry must fail here rather than drop the comparison quietly.
  for (const packageName of ['stripe', '@expo/ui', '@shopify/flash-list']) {
    assert.ok(
      pairs.some(pair => pair.packageName === packageName),
      `${packageName} must have a patch key whose version is compared`
    );
  }
  assert.ok(pairs.length > 0, 'the version comparison must cover declared patch keys');
  assert.deepEqual(versionMismatches(pairs), []);
  assert.deepEqual(uncomparable, []);
});

test('the version comparison reports a patch key that disagrees with a mirror', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patched-dependencies-'));
  try {
    const filePath = path.join(directory, 'pnpm-workspace.yaml');
    fs.writeFileSync(
      filePath,
      [
        'catalog:',
        '  stripe: 23.0.0',
        'patchedDependencies:',
        '  stripe@23.0.1: patches/stripe@23.0.1.patch',
        '',
      ].join('\n')
    );
    assert.deepEqual(versionMismatches(versionCheck(readWorkspaceDocument(filePath)).pairs), [
      'stripe@23.0.1 names 23.0.1, but catalog records 23.0.0',
    ]);

    fs.writeFileSync(
      filePath,
      [
        'catalog:',
        '  stripe: 23.0.1',
        'patchedDependencies:',
        '  stripe@23.0.1: patches/stripe@23.0.1.patch',
        '',
      ].join('\n')
    );
    assert.deepEqual(versionMismatches(versionCheck(readWorkspaceDocument(filePath)).pairs), []);

    fs.writeFileSync(
      filePath,
      [
        'minimumReleaseAgeExclude:',
        "  - '@shopify/flash-list@2.3.2'",
        'patchedDependencies:',
        "  '@shopify/flash-list@2.3.3': patches/@shopify+flash-list@2.3.3.patch",
        '',
      ].join('\n')
    );
    assert.deepEqual(versionMismatches(versionCheck(readWorkspaceDocument(filePath)).pairs), [
      '@shopify/flash-list@2.3.3 names 2.3.3, but minimumReleaseAgeExclude records 2.3.2',
    ]);

    fs.writeFileSync(
      filePath,
      [
        'minimumReleaseAgeExclude:',
        "  - '@shopify/flash-list@2.3.3'",
        'patchedDependencies:',
        "  '@shopify/flash-list@2.3.3': patches/@shopify+flash-list@2.3.3.patch",
        '',
      ].join('\n')
    );
    assert.deepEqual(versionMismatches(versionCheck(readWorkspaceDocument(filePath)).pairs), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the version comparison reports a mirror it cannot compare instead of skipping it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patched-dependencies-'));
  try {
    const filePath = path.join(directory, 'pnpm-workspace.yaml');
    fs.writeFileSync(
      filePath,
      [
        'overrides:',
        "  stripe: '>=23.0.0 <24'",
        'patchedDependencies:',
        '  stripe@23.0.0: patches/stripe@23.0.0.patch',
        '',
      ].join('\n')
    );
    const { pairs, uncomparable } = versionCheck(readWorkspaceDocument(filePath));
    assert.deepEqual(versionMismatches(pairs), []);
    assert.deepEqual(uncomparable, [
      "stripe@23.0.0 has an overrides value '>=23.0.0 <24' that states no single version, so the two cannot be compared",
    ]);

    // `catalog:` states no version of its own but names the catalog pin, so it
    // compares against that instead of being reported as uncomparable.
    fs.writeFileSync(
      filePath,
      [
        'catalog:',
        '  postcss: 8.5.30',
        'overrides:',
        "  postcss: 'catalog:'",
        'patchedDependencies:',
        '  postcss@8.5.30: patches/postcss@8.5.30.patch',
        '',
      ].join('\n')
    );
    const viaCatalog = versionCheck(readWorkspaceDocument(filePath));
    assert.deepEqual(viaCatalog.uncomparable, []);
    assert.deepEqual(viaCatalog.pairs, [
      {
        selector: 'postcss@8.5.30',
        packageName: 'postcss',
        patchVersion: '8.5.30',
        source: 'catalog',
        recordedVersion: '8.5.30',
      },
      {
        selector: 'postcss@8.5.30',
        packageName: 'postcss',
        patchVersion: '8.5.30',
        source: 'overrides',
        recordedVersion: '8.5.30',
      },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
