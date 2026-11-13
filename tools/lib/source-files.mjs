/**
 * The source-tree walk the mobile audits share.
 *
 * Every audit scans the same kind of tree — `.ts`/`.tsx` files below one or two
 * source roots, with `node_modules` pruned — and every audit leaves out files of
 * its own kind. The walk lives here; the exclusion stays at each call site as a
 * required predicate, so no audit inherits a policy it did not state.
 *
 * The audits that read the tree also read each file the same way: its text, its
 * syntax tree, and the lines that say the parser refused it. That step lives
 * here too, so two audits cannot drift apart on which files they read, how they
 * spell a path in a diagnostic, or how they report a file with a syntax error.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative as relativePath, sep } from 'node:path';

import { lineIndex, parseProblems, parseSourceFile } from './ast.mjs';

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

/**
 * Every source file below `dir`, read and parsed once, one file at a time: its
 * absolute path `file`, the normalised path `path` a diagnostic names it by, its
 * `text`, its syntax tree `program`, and one `problems` line per parse error.
 *
 * The walk is a generator, so a caller's `for … of` holds one file's text and
 * one syntax tree at a time and peak memory does not grow with the tree.
 *
 * A file the parser refused has an empty tree, so the keys or calls it holds
 * would leave an audit without a word. `problems` says what the parser stopped
 * at instead, and a caller must report every line of it: an unaudited file is
 * not a clean one.
 *
 * Paths are named from `root`. A file outside it — a fixture tree in a
 * temporary directory — is named from `dir`, so it still reads from its own
 * root.
 */
export function* parseSourceTree(dir, root, skip) {
  for (const file of sourceFiles(dir, skip)) {
    const text = readFileSync(file, 'utf8');
    const { program, errors } = parseSourceFile(file, text);
    const fromRoot = relativePath(root, file);
    const path = (fromRoot.startsWith('..') ? relativePath(dir, file) : fromRoot)
      .split(sep)
      .join('/');
    yield {
      file,
      path,
      text,
      program,
      problems: parseProblems(path, errors, lineIndex(text)),
    };
  }
}
