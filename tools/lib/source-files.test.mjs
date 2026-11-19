import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isTestArtifact, parseSourceTree, sourceFiles } from './source-files.mjs';

test('walks the tree depth-first with entries sorted by name at each level', context => {
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  // Created in a deliberately non-alphabetical order, so name order differs
  // from the order the files were made in and an unsorted readdirSync would
  // very likely disagree.
  writeFileSync(join(root, 'zeta.ts'), '');
  mkdirSync(join(root, 'm_sub'));
  writeFileSync(join(root, 'm_sub', 'a.ts'), '');
  mkdirSync(join(root, 'm_sub', 'node_modules'));
  writeFileSync(join(root, 'm_sub', 'node_modules', 'dep.ts'), '');
  writeFileSync(join(root, 'alpha.tsx'), '');
  writeFileSync(join(root, 'beta.test.ts'), '');
  writeFileSync(join(root, 'm_sub', 'z.tsx'), '');
  writeFileSync(join(root, 'm_sub', 'a.mounted.test.tsx'), '');

  const walked = sourceFiles(root, isTestArtifact);

  assert.deepEqual(walked, [
    join(root, 'alpha.tsx'),
    join(root, 'm_sub', 'a.ts'),
    join(root, 'm_sub', 'z.tsx'),
    join(root, 'zeta.ts'),
  ]);
  // The exact sequence above already leaves the pruned and skipped names out;
  // these spell that out for the three names the fixture plants for it.
  assert.equal(walked.includes(join(root, 'm_sub', 'node_modules', 'dep.ts')), false);
  assert.equal(walked.includes(join(root, 'beta.test.ts')), false);
  assert.equal(walked.includes(join(root, 'm_sub', 'a.mounted.test.tsx')), false);
});

test('leaves out a dangling .ts symlink instead of throwing', context => {
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'a-ok.ts'), '');
  // A link with no target has no source to read, so the walk leaves it out.
  // Admitting it would make every audit read a path that does not exist.
  symlinkSync(join(root, 'missing.ts'), join(root, 'dangling.ts'));

  assert.deepEqual(sourceFiles(root, isTestArtifact), [join(root, 'a-ok.ts')]);
});

test('leaves out a .ts symlink loop instead of throwing', context => {
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'ordinary.ts'), '');
  // Two links that point at each other have no file behind them: following
  // either one fails with ELOOP. `throwIfNoEntry` covers a missing target, not
  // a loop, so the walk has to leave the pair out like a dangling link rather
  // than end on the stat error.
  symlinkSync(join(root, 'b.ts'), join(root, 'a.ts'));
  symlinkSync(join(root, 'a.ts'), join(root, 'b.ts'));

  // Neither link leads to a regular file, so neither is admitted; the ordinary
  // file beside them still is, and nothing throws.
  assert.deepEqual(sourceFiles(root, isTestArtifact), [join(root, 'ordinary.ts')]);
  const entries = [...parseSourceTree(root, root, isTestArtifact)];
  assert.deepEqual(
    entries.map(entry => entry.path),
    ['ordinary.ts']
  );
  assert.deepEqual(entries[0].problems, []);
});

test('keeps a .ts file behind a symlink to a real file', context => {
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'target.ts'), '');
  // readdirSync reports the link rather than its target, so the walk has to
  // look through the link to keep the file it has always walked.
  symlinkSync(join(root, 'target.ts'), join(root, 'link.ts'));

  assert.deepEqual(sourceFiles(root, isTestArtifact), [
    join(root, 'link.ts'),
    join(root, 'target.ts'),
  ]);
});

test('reports an unreadable file as one problem and keeps walking', context => {
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  const locked = join(root, 'locked.ts');
  writeFileSync(join(root, 'a-first.ts'), 'export const a = 1;\n');
  writeFileSync(locked, 'export const b = 2;\n');
  writeFileSync(join(root, 'z-last.ts'), 'export const z = 3;\n');
  chmodSync(locked, 0o000);
  // Restore the mode before the tree is removed, so cleanup cannot trip on it.
  context.after(() => {
    chmodSync(locked, 0o644);
    rmSync(root, { recursive: true, force: true });
  });

  const entries = [...parseSourceTree(root, root, isTestArtifact)];

  assert.deepEqual(
    entries.map(entry => entry.path),
    ['a-first.ts', 'locked.ts', 'z-last.ts']
  );
  const lockedEntry = entries[1];
  // The read the filesystem refuses is one problem line named after the path,
  // so the audit reports it instead of ending on a stack trace.
  assert.equal(lockedEntry.problems.length, 1);
  assert.match(lockedEntry.problems[0], /^locked\.ts: cannot read: /);
  assert.equal(lockedEntry.text, '');
  assert.deepEqual(lockedEntry.program.body, []);
  // The readable files still come through clean: the refusal costs one entry's
  // findings, not the walk.
  assert.deepEqual(entries[0].problems, []);
  assert.deepEqual(entries[2].problems, []);
});
