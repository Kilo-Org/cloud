import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import {
  hasSectionHeading,
  insertSection,
  isVersionBumpCommit,
  parseConfigVersion,
  sectionHeading,
  splitSections,
} from './kilo-app-release-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES = join(HERE, 'kilo-app-release-notes.mjs');
const CAP = join(HERE, 'kilo-app-release-upload-cap.mjs');

function runScript(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...options });
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initRepo(prefix) {
  const dir = tempDir(prefix);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Kilo Test']);
  git(dir, ['config', 'user.email', 'test@kilo.ai']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
  return dir;
}

function writeFixture(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function commit(dir, files, subject, env = {}) {
  for (const [rel, content] of Object.entries(files)) {
    writeFixture(dir, rel, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', subject], { env: { ...process.env, ...env } });
}

function tagAt(dir, name, unixSeconds) {
  git(dir, ['tag', '-a', name, '-m', name], {
    env: { ...process.env, GIT_COMMITTER_DATE: new Date(unixSeconds * 1000).toISOString() },
  });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Minimal ZIP writer (local headers + central directory + EOCD), copied from
// scripts/inspect-mobile-artifacts.test.mjs so the IPA fixture is self-contained.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(outputPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(dataBuffer);
    const entryCrc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(entryCrc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, eocd]));
}

function plistWith({ bundleVersion, shortVersion }) {
  const keys = [];
  if (bundleVersion !== undefined) {
    keys.push(`  <key>CFBundleVersion</key>\n  <string>${bundleVersion}</string>`);
  }
  if (shortVersion !== undefined) {
    keys.push(`  <key>CFBundleShortVersionString</key>\n  <string>${shortVersion}</string>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...keys,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function ipaFixture(dir, plist) {
  const path = join(dir, 'app.ipa');
  writeZip(path, [['Payload/Kilo.app/Info.plist', plist]]);
  return path;
}

test('body lists app PRs oldest first and drops bumps, non-app, changelog and unnumbered commits', () => {
  const dir = initRepo('kilo-notes-body-');
  try {
    commit(dir, { 'apps/mobile/src/first.ts': 'first\n' }, 'feat(mobile): first (#100)');
    git(dir, ['tag', 'base']);
    commit(dir, { 'apps/mobile/src/second.ts': 'second\n' }, 'fix(mobile): second (#101)');
    commit(dir, { 'apps/web/src/third.ts': 'third\n' }, 'feat(web): third (#102)');
    commit(
      dir,
      { 'apps/mobile/app.config.ts': "  version: '1.0.13',\n" },
      'chore(kilo-app): bump version to 1.0.13 (#103)'
    );
    commit(
      dir,
      { 'apps/mobile/CHANGELOG.md': '# changelog\n' },
      'docs(kilo-app): changelog for 1.0.12 (build 42) (#104)'
    );
    commit(dir, { 'apps/mobile/src/fourth.ts': 'fourth\n' }, 'fix(mobile): no pull request ref');
    git(dir, ['tag', 'nopr']);

    const result = runScript(NOTES, ['body', '--from', 'base'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '- fix(mobile): second (#101)\n');

    const empty = runScript(NOTES, ['body', '--from', 'nopr'], { cwd: dir });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, '- No user-visible changes since the previous build.\n');
  } finally {
    cleanup(dir);
  }
});

test('body prints the initial-release marker without --from', () => {
  const result = runScript(NOTES, ['body']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '- Initial release: no earlier build to compare against.\n');
});

test('body exits 2 naming an unresolvable --from ref', () => {
  const dir = initRepo('kilo-notes-badref-');
  try {
    const result = runScript(NOTES, ['body', '--from', 'no-such-ref'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no-such-ref/);
  } finally {
    cleanup(dir);
  }
});

test('sectionHeading names one build or two', () => {
  assert.equal(sectionHeading('1.0.12', '42', '42'), '## 1.0.12 (build 42)');
  assert.equal(sectionHeading('1.0.12', '42', ''), '## 1.0.12 (build 42)');
  assert.equal(sectionHeading('1.0.12', '42', undefined), '## 1.0.12 (build 42)');
  assert.equal(sectionHeading('1.0.12', '42', '43'), '## 1.0.12 (build 42 iOS, 43 Android)');
});

test('parseConfigVersion and isVersionBumpCommit follow the workflow contracts', () => {
  assert.equal(parseConfigVersion("const c = {\n  version: '1.0.12',\n};\n"), '1.0.12');
  assert.equal(parseConfigVersion('no version here'), null);
  assert.equal(
    isVersionBumpCommit(
      ['apps/mobile/app.config.ts'],
      "-  version: '1.0.11',\n+  version: '1.0.12',\n"
    ),
    true
  );
  assert.equal(
    isVersionBumpCommit(['apps/mobile/app.config.ts'], "+  version: '1.0.12',\n+  extra: true,\n"),
    false
  );
  assert.equal(isVersionBumpCommit(['apps/mobile/src/a.ts'], "+  version: '1.0.12',\n"), false);
  assert.equal(
    isVersionBumpCommit(
      ['apps/mobile/app.config.ts', 'apps/mobile/CHANGELOG.md'],
      "-  version: '1.0.11',\n+  version: '1.0.12',\n"
    ),
    true
  );
  assert.equal(
    isVersionBumpCommit(
      ['apps/mobile/app.config.ts', 'apps/mobile/CHANGELOG.md', 'apps/mobile/src/a.ts'],
      "-  version: '1.0.11',\n+  version: '1.0.12',\n"
    ),
    false
  );
});

test('body drops the squashed version-bump merge that carries the changelog', () => {
  const dir = initRepo('kilo-notes-bump-merge-');
  try {
    commit(
      dir,
      {
        'apps/mobile/app.config.ts': "  version: '1.0.12',\n",
        'apps/mobile/CHANGELOG.md':
          '# Kilo App Changelog\n\n## 1.0.11 (build 56)\n\n- old (#90)\n\n',
      },
      'chore(kilo-app): bump version to 1.0.12 (#6999)'
    );
    git(dir, ['tag', 'base']);
    commit(
      dir,
      {
        'apps/mobile/app.config.ts': "  version: '1.0.13',\n",
        'apps/mobile/CHANGELOG.md':
          '# Kilo App Changelog\n\n## 1.0.12 (build 57)\n\n- old (#90)\n\n## 1.0.11 (build 56)\n\n- old (#90)\n\n',
      },
      'chore(kilo-app): bump version to 1.0.13 (#7000)'
    );
    const bumpMerge = git(dir, ['rev-parse', 'HEAD']).trim();
    commit(dir, { 'apps/mobile/src/next.ts': 'next\n' }, 'fix(mobile): a real fix (#7002)');

    const result = runScript(NOTES, ['body', '--from', 'base'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '- fix(mobile): a real fix (#7002)\n');

    const onlyBump = runScript(NOTES, ['body', '--from', 'base', '--to', bumpMerge], { cwd: dir });
    assert.equal(onlyBump.status, 0, onlyBump.stderr);
    assert.equal(onlyBump.stdout, '- No user-visible changes since the previous build.\n');
  } finally {
    cleanup(dir);
  }
});

test('insertSection keeps every older line and hasSectionHeading detects a duplicate', () => {
  const older = '# Kilo App Changelog\n\nprose\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n';
  const section = '## 1.0.12 (build 42)\n\n- new (#91)\n\n';
  const inserted = insertSection(older, section);
  assert.equal(
    inserted,
    '# Kilo App Changelog\n\nprose\n\n## 1.0.12 (build 42)\n\n- new (#91)\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
  );
  for (const line of older.split('\n')) {
    assert.ok(inserted.split('\n').includes(line), `lost older line: ${line}`);
  }
  assert.equal(hasSectionHeading(inserted, '## 1.0.12 (build 42)'), true);
  assert.equal(hasSectionHeading(inserted, '## 1.0.13 (build 43)'), false);
});

test('write inserts above the newest section and is a no-op on a duplicate heading', () => {
  const dir = initRepo('kilo-notes-write-');
  try {
    const changelog = writeFixture(
      dir,
      'apps/mobile/CHANGELOG.md',
      '# Kilo App Changelog\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    writeFixture(dir, 'notes.md', '- new (#91)\n- another (#92)\n');
    const first = runScript(
      NOTES,
      ['write', '--version', '1.0.12', '--ios-build', '42', '--body-file', 'notes.md'],
      { cwd: dir }
    );
    assert.equal(first.status, 0, first.stderr);
    const content = readFileSync(changelog, 'utf8');
    assert.equal(
      content,
      '# Kilo App Changelog\n\n## 1.0.12 (build 42)\n\n- new (#91)\n- another (#92)\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );

    const second = runScript(
      NOTES,
      ['write', '--version', '1.0.12', '--ios-build', '42', '--body-file', 'notes.md'],
      { cwd: dir }
    );
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /changelog: ## 1\.0\.12 \(build 42\) already present/);
    assert.equal(readFileSync(changelog, 'utf8'), content);
  } finally {
    cleanup(dir);
  }
});

test('write --print-only prints the section and touches no file', () => {
  const dir = initRepo('kilo-notes-print-');
  try {
    writeFixture(dir, 'notes.md', '- new (#91)\n');
    const result = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--android-build',
        '43',
        '--body-file',
        'notes.md',
        '--print-only',
      ],
      { cwd: dir }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '## 1.0.12 (build 42 iOS, 43 Android)\n\n- new (#91)\n\n');
    assert.equal(existsSync(join(dir, 'apps/mobile/CHANGELOG.md')), false);
  } finally {
    cleanup(dir);
  }
});

test('identity reads the IPA Info.plist and the Android build number', () => {
  const dir = initRepo('kilo-notes-identity-');
  try {
    writeFixture(dir, 'app.config.ts', "const config = {\n  version: '1.0.12',\n};\n");
    ipaFixture(dir, plistWith({ bundleVersion: '42', shortVersion: '1.0.12' }));
    writeFixture(
      dir,
      'build.json',
      JSON.stringify([{ platform: 'ANDROID', metadata: { appBuildVersion: '43' } }])
    );
    const result = runScript(
      NOTES,
      ['identity', '--config', 'app.config.ts', '--ipa', 'app.ipa', '--build-json', 'build.json'],
      { cwd: dir }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^version=1\.0\.12$/m);
    assert.match(result.stdout, /^ios_build=42$/m);
    assert.match(result.stdout, /^android_build=43$/m);
  } finally {
    cleanup(dir);
  }
});

test('identity exits 1 when the IPA version disagrees with the config', () => {
  const dir = initRepo('kilo-notes-mismatch-');
  try {
    writeFixture(dir, 'app.config.ts', "const config = {\n  version: '1.0.12',\n};\n");
    ipaFixture(dir, plistWith({ bundleVersion: '42', shortVersion: '1.0.99' }));
    const result = runScript(NOTES, ['identity', '--config', 'app.config.ts', '--ipa', 'app.ipa'], {
      cwd: dir,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1\.0\.99/);
  } finally {
    cleanup(dir);
  }
});

test('identity exits 1 when the IPA has no CFBundleVersion', () => {
  const dir = initRepo('kilo-notes-nobuild-');
  try {
    writeFixture(dir, 'app.config.ts', "const config = {\n  version: '1.0.12',\n};\n");
    ipaFixture(dir, plistWith({ shortVersion: '1.0.12' }));
    const result = runScript(NOTES, ['identity', '--config', 'app.config.ts', '--ipa', 'app.ipa'], {
      cwd: dir,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CFBundleVersion/);
  } finally {
    cleanup(dir);
  }
});

test('identity exits 1 when the IPA cannot be read', () => {
  const dir = initRepo('kilo-notes-noipa-');
  try {
    writeFixture(dir, 'app.config.ts', "const config = {\n  version: '1.0.12',\n};\n");
    const result = runScript(
      NOTES,
      ['identity', '--config', 'app.config.ts', '--ipa', 'missing.ipa'],
      { cwd: dir }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read --ipa/);
  } finally {
    cleanup(dir);
  }
});

// build.json is the only source of the Android build number, so an unreadable,
// partial or versionless one is an identity error: the run must fail before the
// submission instead of labelling the Android store build `unknown`.
test('identity exits 1 when build.json cannot name the Android build', () => {
  const cases = [
    ['unparseable JSON', '{ not json', /cannot read build\.json/],
    ['not a JSON array', JSON.stringify({ platform: 'ANDROID' }), /not a JSON array/],
    ['no ANDROID build', JSON.stringify([{ platform: 'IOS' }]), /has no ANDROID build/],
    [
      'no appBuildVersion',
      JSON.stringify([{ platform: 'ANDROID', metadata: {} }]),
      /has no appBuildVersion/,
    ],
    [
      'empty appBuildVersion',
      JSON.stringify([{ platform: 'ANDROID', metadata: { appBuildVersion: '' } }]),
      /has no appBuildVersion/,
    ],
  ];
  for (const [label, contents, expected] of cases) {
    const dir = initRepo('kilo-notes-android-');
    try {
      writeFixture(dir, 'app.config.ts', "const config = {\n  version: '1.0.12',\n};\n");
      ipaFixture(dir, plistWith({ bundleVersion: '42', shortVersion: '1.0.12' }));
      writeFixture(dir, 'build.json', contents);
      const result = runScript(
        NOTES,
        ['identity', '--config', 'app.config.ts', '--ipa', 'app.ipa', '--build-json', 'build.json'],
        { cwd: dir }
      );
      assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, expected, label);
      assert.equal(
        result.stdout.includes('android_build='),
        false,
        `${label} must print no store identity for the submission to read`
      );
    } finally {
      cleanup(dir);
    }
  }
});

test('write --land retries a rejected push once and lands one section', () => {
  const root = tempDir('kilo-notes-land-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);

    writeFixture(seed, 'apps/mobile/CHANGELOG.md', '# Kilo App Changelog\n\nprose\n');
    writeFixture(seed, 'apps/mobile/app.config.ts', "  version: '1.0.12',\n");
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['branch', '-M', 'main']);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(seed, ['checkout', '-q', '-b', 'bump']);
    git(seed, ['push', '-q', 'origin', 'bump']);

    // A second writer that advances the branch between the script's attempts.
    const other = join(root, 'other');
    git(root, ['clone', '-q', remote, other]);
    git(other, ['config', 'user.name', 'Kilo Other']);
    git(other, ['config', 'user.email', 'other@kilo.ai']);
    git(other, ['config', 'commit.gpgsign', 'false']);
    git(other, ['checkout', '-q', 'bump']);
    writeFixture(
      other,
      'apps/mobile/CHANGELOG.md',
      '# Kilo App Changelog\n\nprose\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'docs(kilo-app): older section (#105)']);

    // The first push is rejected after the branch has moved; the retry wins.
    const flag = join(seed, '.git', 'kilo-first-push');
    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -f "${flag}" ]; then\n  : > "${flag}"\n  git -C "${other}" push -q origin bump:bump || true\n  echo "kilo-test: the branch advanced; rejecting this push" >&2\n  exit 1\nfi\nexit 0\n`
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'notes.md', '- new (#91)\n');
    const result = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'notes.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changelog: attempt 1 rejected/);
    assert.match(result.stdout, /changelog: landed ## 1\.0\.12 \(build 42\) on bump as [0-9a-f]+/);

    git(other, ['fetch', '-q', 'origin', 'bump']);
    const landed = git(other, ['show', 'origin/bump:apps/mobile/CHANGELOG.md']);
    assert.equal(
      landed,
      '# Kilo App Changelog\n\nprose\n\n## 1.0.12 (build 42)\n\n- new (#91)\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    assert.equal(landed.match(/^## /gm).length, 2);
  } finally {
    cleanup(root);
  }
});

test('write --land exits 1 when the section can be neither landed nor carried', () => {
  const root = tempDir('kilo-notes-land-fail-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(seed, 'apps/mobile/CHANGELOG.md', '# Kilo App Changelog\n\nprose\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);

    // Every push is refused, the pending carry included: nothing can be saved,
    // so the failure is real and must be reported.
    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho "kilo-test: rejected" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    writeFixture(seed, 'notes.md', '- new (#91)\n');
    const result = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'notes.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not land/);
    assert.match(result.stderr, /or carry it to kilo-app-changelog-pending/);
    assert.equal(result.stdout.match(/changelog: attempt \d rejected/g).length, 4);
  } finally {
    cleanup(root);
  }
});

test('a land whose branch is gone carries the section to the pending branch', () => {
  const root = tempDir('kilo-notes-carry-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(
      seed,
      'apps/mobile/CHANGELOG.md',
      '# Kilo App Changelog\n\nprose\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:main']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);

    // The bump branch was merged and auto-deleted while the build ran: its push
    // is refused, but the pending branch still accepts the section.
    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read -r _ _ remote_ref _; do\n  case "$remote_ref" in\n    refs/heads/bump) echo "kilo-test: bump is gone" >&2; exit 1 ;;\n  esac\ndone\nexit 0\n'
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'notes.md', '- new (#91)\n');
    const carried = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'notes.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(carried.status, 0, carried.stderr);
    assert.match(
      carried.stdout,
      /changelog: pending ## 1\.0\.12 \(build 42\) carried to kilo-app-changelog-pending/
    );

    git(seed, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.pending.md']),
      '## 1.0.12 (build 42)\n\n- new (#91)\n\n'
    );

    // The next build's branch accepts the section again: its own section goes
    // above the carried one, and the pending branch is dropped.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    writeFixture(seed, 'next.md', '- next (#92)\n');
    const landed = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.13',
        '--ios-build',
        '43',
        '--body-file',
        'next.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(landed.status, 0, landed.stderr);
    assert.match(landed.stdout, /changelog: landed ## 1\.0\.13 \(build 43\) on bump as [0-9a-f]+/);

    git(seed, ['fetch', '-q', 'origin', 'bump']);
    const content = git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.md']);
    assert.equal(
      content,
      '# Kilo App Changelog\n\nprose\n\n## 1.0.13 (build 43)\n\n- next (#92)\n\n## 1.0.12 (build 42)\n\n- new (#91)\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );

    const pendingRefs = git(seed, ['ls-remote', '--heads', 'origin', 'kilo-app-changelog-pending']);
    assert.equal(pendingRefs, '', 'the pending branch must be dropped once its sections land');

    // A re-run of the same build is a no-op that still reports the section as
    // landed, so the changelog job opens or refreshes the PR for it.
    const rerun = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.13',
        '--ios-build',
        '43',
        '--body-file',
        'next.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(
      rerun.stdout,
      /changelog: landed ## 1\.0\.13 \(build 43\) on bump \(already present\)/
    );
  } finally {
    cleanup(root);
  }
});

test('two failed lands accumulate in the pending branch, newest first', () => {
  const root = tempDir('kilo-notes-carry-many-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(
      seed,
      'apps/mobile/CHANGELOG.md',
      '# Kilo App Changelog\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);

    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read -r _ _ remote_ref _; do\n  case "$remote_ref" in\n    refs/heads/bump) echo "kilo-test: bump is gone" >&2; exit 1 ;;\n  esac\ndone\nexit 0\n'
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'a.md', '- a (#91)\n');
    const first = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'a.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(first.status, 0, first.stderr);
    writeFixture(seed, 'b.md', '- b (#92)\n');
    const second = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.13',
        '--ios-build',
        '43',
        '--body-file',
        'b.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(second.status, 0, second.stderr);

    git(seed, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.pending.md']),
      '## 1.0.13 (build 43)\n\n- b (#92)\n\n## 1.0.12 (build 42)\n\n- a (#91)\n\n'
    );

    // The third build's branch accepts the section: all three land in order.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    writeFixture(seed, 'c.md', '- c (#93)\n');
    const third = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.14',
        '--ios-build',
        '44',
        '--body-file',
        'c.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(third.status, 0, third.stderr);
    git(seed, ['fetch', '-q', 'origin', 'bump']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.md']),
      '# Kilo App Changelog\n\n## 1.0.14 (build 44)\n\n- c (#93)\n\n## 1.0.13 (build 43)\n\n- b (#92)\n\n## 1.0.12 (build 42)\n\n- a (#91)\n\n## 1.0.11 (build 41)\n\n- old (#90)\n\n'
    );
    assert.equal(git(seed, ['ls-remote', '--heads', 'origin', 'kilo-app-changelog-pending']), '');
  } finally {
    cleanup(root);
  }
});

// Two runs can fail to land in the same window. Each one carries the sections it
// read and writes the whole pending branch, so without a compare-and-swap on the
// commit it read, the second push would drop the section the first one just
// carried there.
test('a carry whose pending branch advanced under it keeps both sections', () => {
  const root = tempDir('kilo-notes-carry-race-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(seed, 'apps/mobile/CHANGELOG.md', '# Kilo App Changelog\n\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);
    const seedBranch = git(seed, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    // An earlier build already carried one section to the pending branch.
    const carried = '## 1.0.11 (build 41)\n\n- older (#90)\n\n';
    git(seed, ['checkout', '-q', '-b', 'carried']);
    writeFixture(seed, 'apps/mobile/CHANGELOG.pending.md', carried);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: carried']);
    git(seed, ['push', '-q', 'origin', 'HEAD:kilo-app-changelog-pending']);
    git(seed, ['checkout', '-q', seedBranch]);

    // A second run holds its own carry of another build's section, ready to land
    // on the pending branch at the instant this run pushes its own.
    const other = '## 1.0.13 (build 43)\n\n- other (#93)\n\n';
    const writer = join(root, 'writer');
    git(root, ['clone', '-q', remote, writer]);
    git(writer, ['config', 'user.name', 'Kilo Test']);
    git(writer, ['config', 'user.email', 'test@kilo.ai']);
    git(writer, ['config', 'commit.gpgsign', 'false']);
    git(writer, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    git(writer, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
    writeFixture(writer, 'apps/mobile/CHANGELOG.pending.md', `${other}${carried}`);
    git(writer, ['add', '-A']);
    git(writer, ['commit', '-q', '-m', 'chore: competing carry']);
    const competing = git(writer, ['rev-parse', 'HEAD']).trim();

    // This run's first push to the pending branch loses that race exactly as a
    // stale compare-and-swap would: the other run's carry lands first and the
    // push is refused. The push after the re-read sees the advanced branch and
    // is allowed through.
    const raced = join(root, 'raced');
    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read -r _ _ remote_ref _; do',
        '  case "$remote_ref" in',
        '    refs/heads/bump) echo "kilo-test: bump is gone" >&2; exit 1 ;;',
        '    refs/heads/kilo-app-changelog-pending)',
        `      if [ ! -f "${raced}" ]; then`,
        `        : > "${raced}"`,
        `        git -C "${writer}" push -q --force origin "${competing}:refs/heads/kilo-app-changelog-pending" || exit 1`,
        '        echo "kilo-test: the pending branch advanced under this run" >&2',
        '        exit 1',
        '      fi',
        '      ;;',
        '  esac',
        'done',
        'exit 0',
        '',
      ].join('\n')
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'notes.md', '- mine (#92)\n');
    const result = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'notes.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /changelog: pending ## 1\.0\.12 \(build 42\) carried to kilo-app-changelog-pending/
    );

    git(seed, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.pending.md']),
      `## 1.0.12 (build 42)\n\n- mine (#92)\n\n${other}${carried}`,
      'the section this run carried and the one it raced must both survive'
    );
  } finally {
    cleanup(root);
  }
});

// A land reads the pending branch, incorporates its sections, and then deletes
// the branch. A carry that lands in that window must not be deleted with it.
test('a land keeps a pending branch that advanced after its snapshot', () => {
  const root = tempDir('kilo-notes-clear-race-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(
      seed,
      'apps/mobile/CHANGELOG.md',
      '# Kilo App Changelog\n\n## 1.0.10 (build 40)\n\n- oldest (#89)\n\n'
    );
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);
    const seedBranch = git(seed, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    const carried = '## 1.0.11 (build 41)\n\n- older (#90)\n\n';
    git(seed, ['checkout', '-q', '-b', 'carried']);
    writeFixture(seed, 'apps/mobile/CHANGELOG.pending.md', carried);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: carried']);
    git(seed, ['push', '-q', 'origin', 'HEAD:kilo-app-changelog-pending']);
    git(seed, ['checkout', '-q', seedBranch]);

    const other = '## 1.0.13 (build 43)\n\n- other (#93)\n\n';
    const writer = join(root, 'writer');
    git(root, ['clone', '-q', remote, writer]);
    git(writer, ['config', 'user.name', 'Kilo Test']);
    git(writer, ['config', 'user.email', 'test@kilo.ai']);
    git(writer, ['config', 'commit.gpgsign', 'false']);
    git(writer, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    git(writer, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
    writeFixture(writer, 'apps/mobile/CHANGELOG.pending.md', `${other}${carried}`);
    git(writer, ['add', '-A']);
    git(writer, ['commit', '-q', '-m', 'chore: competing carry']);
    const competing = git(writer, ['rev-parse', 'HEAD']).trim();

    // The other run's carry lands on the pending branch while this run pushes
    // its changelog onto the version-bump branch: after this run read the
    // pending branch, before it clears it. The clear must then refuse.
    const raced = join(root, 'raced');
    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read -r _ _ remote_ref _; do',
        '  case "$remote_ref" in',
        '    refs/heads/bump)',
        `      if [ ! -f "${raced}" ]; then`,
        `        : > "${raced}"`,
        `        git -C "${writer}" push -q --force origin "${competing}:refs/heads/kilo-app-changelog-pending" || exit 1`,
        '        echo "kilo-test: another run carried a section while this run landed" >&2',
        '      fi',
        '      ;;',
        '  esac',
        'done',
        'exit 0',
        '',
      ].join('\n')
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'notes.md', '- mine (#92)\n');
    const result = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.12',
        '--ios-build',
        '42',
        '--body-file',
        'notes.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changelog: landed ## 1\.0\.12 \(build 42\) on bump as [0-9a-f]+/);

    const pendingRefs = git(seed, ['ls-remote', '--heads', 'origin', 'kilo-app-changelog-pending']);
    assert.notEqual(
      pendingRefs,
      '',
      'the branch advanced after the read, so the clear must refuse'
    );
    git(seed, ['fetch', '-q', 'origin', 'kilo-app-changelog-pending']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.pending.md']),
      `${other}${carried}`,
      'the carry that landed in the window must stay on the branch'
    );

    git(seed, ['fetch', '-q', 'origin', 'bump']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.md']),
      '# Kilo App Changelog\n\n## 1.0.12 (build 42)\n\n- mine (#92)\n\n## 1.0.11 (build 41)\n\n- older (#90)\n\n## 1.0.10 (build 40)\n\n- oldest (#89)\n\n'
    );

    // The next build lands its own section, carries the section the refused
    // clear left behind, and clears the branch because nothing advanced since
    // it read them.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    writeFixture(seed, 'next.md', '- next (#94)\n');
    const next = runScript(
      NOTES,
      [
        'write',
        '--version',
        '1.0.14',
        '--ios-build',
        '44',
        '--body-file',
        'next.md',
        '--land',
        'origin:bump',
      ],
      { cwd: seed }
    );
    assert.equal(next.status, 0, next.stderr);
    assert.equal(
      git(seed, ['ls-remote', '--heads', 'origin', 'kilo-app-changelog-pending']),
      '',
      'the branch matches the snapshot the next land read, so it is dropped'
    );
    git(seed, ['fetch', '-q', 'origin', 'bump']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.md']),
      '# Kilo App Changelog\n\n## 1.0.14 (build 44)\n\n- next (#94)\n\n## 1.0.13 (build 43)\n\n- other (#93)\n\n## 1.0.12 (build 42)\n\n- mine (#92)\n\n## 1.0.11 (build 41)\n\n- older (#90)\n\n## 1.0.10 (build 40)\n\n- oldest (#89)\n\n'
    );
  } finally {
    cleanup(root);
  }
});

test('a retry of a carried build writes its section once', () => {
  const root = tempDir('kilo-notes-carry-retry-');
  try {
    const remote = join(root, 'remote.git');
    git(root, ['init', '-q', '--bare', remote]);
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', remote, seed]);
    git(seed, ['config', 'user.name', 'Kilo Test']);
    git(seed, ['config', 'user.email', 'test@kilo.ai']);
    git(seed, ['config', 'commit.gpgsign', 'false']);
    writeFixture(seed, 'apps/mobile/CHANGELOG.md', '# Kilo App Changelog\n\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'chore: seed']);
    git(seed, ['push', '-q', 'origin', 'HEAD:bump']);

    const hook = join(seed, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read -r _ _ remote_ref _; do\n  case "$remote_ref" in\n    refs/heads/bump) echo "kilo-test: bump is gone" >&2; exit 1 ;;\n  esac\ndone\nexit 0\n'
    );
    chmodSync(hook, 0o755);

    writeFixture(seed, 'a.md', '- a (#91)\n');
    const args = [
      'write',
      '--version',
      '1.0.12',
      '--ios-build',
      '42',
      '--body-file',
      'a.md',
      '--land',
      'origin:bump',
    ];
    assert.equal(runScript(NOTES, args, { cwd: seed }).status, 0);

    // The same build runs again and its branch accepts the section now: the
    // carried copy must not be written a second time.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    const retry = runScript(NOTES, args, { cwd: seed });
    assert.equal(retry.status, 0, retry.stderr);
    git(seed, ['fetch', '-q', 'origin', 'bump']);
    assert.equal(
      git(seed, ['show', 'FETCH_HEAD:apps/mobile/CHANGELOG.md']),
      '# Kilo App Changelog\n\n## 1.0.12 (build 42)\n\n- a (#91)\n\n'
    );
    assert.equal(git(seed, ['ls-remote', '--heads', 'origin', 'kilo-app-changelog-pending']), '');
  } finally {
    cleanup(root);
  }
});

test('splitSections keeps every carried section and its heading', () => {
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections('## 1.0.12 (build 42)\n\n- new (#91)\n\n'), [
    '## 1.0.12 (build 42)\n\n- new (#91)\n\n',
  ]);
  assert.deepEqual(
    splitSections(
      '## 1.0.13 (build 43)\n\n- next (#92)\n\n## 1.0.12 (build 42)\n\n- new (#91)\n\n'
    ),
    ['## 1.0.13 (build 43)\n\n- next (#92)\n\n', '## 1.0.12 (build 42)\n\n- new (#91)\n\n']
  );
});

test('notes usage errors exit 2', () => {
  assert.equal(runScript(NOTES, ['write']).status, 2);
  assert.equal(runScript(NOTES, ['unknown']).status, 2);
});

const NOW = '2026-09-23T06:44:56Z';
const NOW_MS = Date.parse(NOW);
const NOW_S = Math.floor(NOW_MS / 1000);
const WINDOW_START_S = Math.floor((NOW_MS - 24 * 3_600_000) / 1000);

test('the cap window counts a tag exactly at now and drops one at the window start', () => {
  const dir = initRepo('kilo-cap-edge-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    tagAt(dir, 'kilo-app-upload/at-window-start', WINDOW_START_S);
    tagAt(dir, 'kilo-app-upload/just-inside', WINDOW_START_S + 1);
    tagAt(dir, 'kilo-app-upload/at-now', NOW_S);
    const result = runScript(CAP, ['--cap', '10', '--now', NOW], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'kilo-app release upload cap: 2 App Store Connect uploads in the last 24h (cap 10, window 2026-09-22T06:44:56Z..2026-09-23T06:44:56Z)'
    );
    assert.equal(lines[1], 'kilo-app release upload cap: 2 of 10 slots used - proceeding');
    assert.equal(lines[2], 'allowed=true');
  } finally {
    cleanup(dir);
  }
});

test('21 uploads in the window hold the release; a different now sees none', () => {
  const dir = initRepo('kilo-cap-hold-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    const base = Math.floor(Date.parse('2026-09-23T00:00:00Z') / 1000);
    for (let index = 0; index < 21; index += 1) {
      tagAt(dir, `kilo-app-upload/2026-09-23-${String(index).padStart(3, '0')}`, base + index * 60);
    }
    const held = runScript(CAP, ['--cap', '10', '--now', NOW], { cwd: dir });
    assert.equal(held.status, 0, held.stderr);
    const lines = held.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'kilo-app release upload cap: 21 App Store Connect uploads in the last 24h (cap 10, window 2026-09-22T06:44:56Z..2026-09-23T06:44:56Z)'
    );
    assert.equal(
      lines[1],
      'kilo-app release upload cap: HOLD - nothing is built; the oldest upload in the window (kilo-app-upload/2026-09-23-000, 2026-09-23T00:00:00Z) frees a slot at 2026-09-24T00:00:00Z; the next run (a push, or the hourly schedule) picks the release up'
    );
    assert.equal(lines[2], 'allowed=false');

    const earlier = runScript(CAP, ['--cap', '10', '--now', '2026-09-21T00:00:00Z'], {
      cwd: dir,
    });
    assert.equal(earlier.status, 0, earlier.stderr);
    const earlierLines = earlier.stdout.trimEnd().split('\n');
    assert.equal(
      earlierLines[0],
      'kilo-app release upload cap: 0 App Store Connect uploads in the last 24h (cap 10, window 2026-09-20T00:00:00Z..2026-09-21T00:00:00Z)'
    );
    assert.equal(earlierLines[1], 'kilo-app release upload cap: 0 of 10 slots used - proceeding');
    assert.equal(earlierLines[2], 'allowed=true');
  } finally {
    cleanup(dir);
  }
});

test('no tags at all proceeds and an unreadable tag history exits 1', () => {
  const dir = initRepo('kilo-cap-empty-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    const empty = runScript(CAP, ['--now', NOW], { cwd: dir });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.trimEnd().split('\n')[2], 'allowed=true');
  } finally {
    cleanup(dir);
  }

  const outside = tempDir('kilo-cap-nogit-');
  try {
    const result = runScript(CAP, ['--now', NOW], { cwd: outside });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot list the upload markers/);
  } finally {
    cleanup(outside);
  }
});

test('the cap counts iOS upload markers and ignores release tags', () => {
  const dir = initRepo('kilo-cap-markers-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    const base = Math.floor(Date.parse('2026-09-23T00:00:00Z') / 1000);
    // A release tag is written only after Submit iOS *and* Submit Android, so a
    // partial run has an upload marker and no release tag: only markers count.
    for (let index = 0; index < 9; index += 1) {
      tagAt(dir, `kilo-app-upload/2026-09-23-${index}`, base + index * 60);
    }
    for (let index = 0; index < 2; index += 1) {
      tagAt(dir, `kilo-app-release/2026-09-23-${index}`, base + 600 + index * 60);
    }
    const result = runScript(CAP, ['--cap', '10', '--now', NOW], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'kilo-app release upload cap: 9 App Store Connect uploads in the last 24h (cap 10, window 2026-09-22T06:44:56Z..2026-09-23T06:44:56Z)'
    );
    assert.equal(lines[1], 'kilo-app release upload cap: 9 of 10 slots used - proceeding');
    assert.equal(lines[2], 'allowed=true');

    // Nine markers plus the two release tags stay under the cap: only the
    // markers count. A tenth marker is the upload that holds the gate.
    tagAt(dir, 'kilo-app-upload/2026-09-23-tenth', base + 1200);
    const held = runScript(CAP, ['--cap', '10', '--now', NOW], { cwd: dir });
    assert.equal(held.status, 0, held.stderr);
    assert.equal(held.stdout.trimEnd().split('\n')[2], 'allowed=false');
  } finally {
    cleanup(dir);
  }
});

test('--prefix narrows the count to the named marker prefix', () => {
  const dir = initRepo('kilo-cap-prefix-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    const base = Math.floor(Date.parse('2026-09-23T00:00:00Z') / 1000);
    tagAt(dir, 'kilo-app-upload/2026-09-23-000', base);
    tagAt(dir, 'other-prefix/2026-09-23-000', base + 60);
    const result = runScript(CAP, ['--cap', '10', '--now', NOW, '--prefix', 'other-prefix/'], {
      cwd: dir,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd().split('\n')[2], 'allowed=true');
    assert.match(result.stdout, /1 App Store Connect uploads in the last 24h/);
  } finally {
    cleanup(dir);
  }
});

test('cap usage errors exit 2', () => {
  assert.equal(runScript(CAP, ['--cap', 'nope']).status, 2);
  assert.equal(runScript(CAP, ['--now', 'not-a-date']).status, 2);
  assert.equal(runScript(CAP, ['--unknown']).status, 2);
});

// `--cap 9.5` would admit a run with nine markers and raise the count to ten,
// above the count the caller asked to hold, so a fractional cap is a usage
// error rather than a rounded one.
test('a fractional cap exits 2 instead of admitting one upload too many', () => {
  const dir = initRepo('kilo-cap-fraction-');
  try {
    commit(dir, { 'README.md': 'x\n' }, 'chore: seed');
    for (let index = 0; index < 9; index += 1) {
      tagAt(dir, `kilo-app-upload/marker-${index}`, NOW_S - 60);
    }
    const result = runScript(CAP, ['--cap', '9.5', '--now', NOW], { cwd: dir });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /--cap must be a positive whole number/);
    assert.equal(result.stdout.includes('allowed=true'), false);
  } finally {
    cleanup(dir);
  }
});
