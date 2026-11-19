import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

import { isTestArtifact, parseSourceEntry, parseSourceTree, sourceFiles } from './source-files.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const refusing = join(root, 'cannot.ts');
  writeFileSync(join(root, 'a-first.ts'), 'export const a = 1;\n');
  writeFileSync(refusing, 'export const b = 2;\n');
  writeFileSync(join(root, 'z-last.ts'), 'export const z = 3;\n');
  // The reader fails one path and defers to the filesystem for the others, so
  // the walk meets exactly one refused read on every machine. A chmod fixture
  // cannot say that: root reads a mode-000 file, so the test skipped as root.
  const refusal = 'the injected reader refused this file';
  const read = (file, encoding) => {
    if (file === refusing) {
      throw new Error(refusal);
    }
    return readFileSync(file, encoding);
  };

  const entries = [...parseSourceTree(root, root, isTestArtifact, read)];

  // A refusal must not drop the entry or end the walk, so the refused file and
  // both neighbours are still named, in name order.
  assert.deepEqual(
    entries.map(entry => entry.path),
    ['a-first.ts', 'cannot.ts', 'z-last.ts']
  );
  const refusedEntry = entries[1];
  // The refused read is one problem line named after the path, so the audit
  // reports it instead of ending on a stack trace — the same line whichever
  // reader refused.
  assert.equal(refusedEntry.problems.length, 1);
  assert.match(refusedEntry.problems[0], new RegExp(`^cannot\\.ts: cannot read: ${refusal}$`));
  // The entry still has the shared shape, so a caller reads its own findings as
  // none rather than tripping over a missing field.
  assert.equal(refusedEntry.text, '');
  assert.deepEqual(refusedEntry.program.body, []);
  // The readable files still come through clean: the refusal costs one entry's
  // findings, not the walk.
  assert.deepEqual(entries[0].problems, []);
  assert.deepEqual(entries[2].problems, []);
  // The last entry's text is the file's own, so the reader was consulted for
  // the reads and the walk continued past the refused file.
  assert.equal(entries[2].text, 'export const z = 3;\n');
  // The filesystem can read what the reader refused, so the throw came from the
  // injected reader and not from an unreadable file.
  assert.equal(readFileSync(join(root, 'cannot.ts'), 'utf8'), 'export const b = 2;\n');
});

test('names a file absolutely when the walk is given a relative directory', context => {
  // Resolved, because the walk resolves its own arguments: a platform whose
  // temporary directory is a symlink would otherwise compare the resolved
  // `file` against an unresolved fixture path and fail for no real reason.
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'source-files-')));
  const previous = process.cwd();
  context.after(() => {
    // The cwd is process-wide state, so it is restored even when an assertion
    // above failed and left the test body early.
    process.chdir(previous);
    rmSync(fixture, { recursive: true, force: true });
  });

  mkdirSync(join(fixture, 'src'));
  writeFileSync(join(fixture, 'src', 'a.ts'), 'export const a = 1;\n');
  process.chdir(fixture);

  // A caller that spells its paths relative still gets the absolute `file` the
  // entry contract promises, and a `path` spelled from `root` exactly as the
  // same call with absolute paths spells it.
  const [entry] = [...parseSourceTree('src', 'src', isTestArtifact)];
  assert.equal(isAbsolute(entry.file), true);
  assert.equal(entry.file, join(fixture, 'src', 'a.ts'));
  assert.equal(entry.path, 'a.ts');

  const direct = parseSourceEntry('src', 'src', join('src', 'a.ts'), 'export const a = 1;\n');
  assert.equal(isAbsolute(direct.file), true);
  assert.equal(direct.file, join(fixture, 'src', 'a.ts'));
  assert.equal(direct.path, 'a.ts');
});
