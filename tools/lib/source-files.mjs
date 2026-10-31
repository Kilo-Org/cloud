/**
 * The source-tree walk the mobile audits share.
 *
 * Every audit scans the same kind of tree — `.ts`/`.tsx` files below one or two
 * source roots, with `node_modules` pruned — and every audit leaves out files of
 * its own kind. The walk lives here; the exclusion stays at each call site as a
 * required predicate, so no audit inherits a policy it did not state.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a file name is test scaffolding rather than app code: a suite
 * (`x.test.ts`), a mounted harness (`x.mounted.test.tsx`) and the helper a
 * harness shares with its suite (`x.mounted.test-helpers.ts`). Every audit that
 * reads copy, classes or formatters passes this predicate. It matches the two
 * name segments, so a helper named only `x.test-helpers.ts` still counts as app
 * code — say so here rather than widening the rule silently.
 */
export function isTestArtifact(name) {
  return name.includes('.test.') || name.includes('.mounted.');
}

/**
 * Every `.ts`/`.tsx` file below `dir`, depth-first, with `node_modules` pruned.
 * `skip` receives each candidate's file name and decides whether the audit
 * leaves it out.
 */
export function sourceFiles(dir, skip) {
  const files = [];
  collect(dir, skip, files);
  return files;
}

function collect(dir, skip, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collect(path, skip, files);
      }
    } else if (/\.tsx?$/.test(entry.name) && !skip(entry.name)) {
      files.push(path);
    }
  }
}
