import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isTestArtifact, sourceFiles } from './source-files.mjs';

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
