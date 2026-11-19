/**
 * The source-tree walk the mobile audits share.
 *
 * Every audit scans the same kind of tree — `.ts`/`.tsx` files below one or two
 * source roots, with `node_modules` pruned — and every audit leaves out files of
 * its own kind. The walk lives here; the exclusion stays at each call site as a
 * required predicate, so no audit inherits a policy it did not state.
 *
 * The audits that read the tree also read each file the same way, whether they
 * take the walk below or one file whose text they already hold: its text, its
 * syntax tree, and the lines that say the parser refused it. That step lives
 * here too, so two audits cannot drift apart on which files they read, how they
 * spell a path in a diagnostic, or how they report a file with a syntax error.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 *
 * The walk takes regular files, and a symlink to one counts: the walk follows
 * the link, because a file kept behind a link still has source to read. A link
 * with no target has no source, so it is left out rather than admitted and
 * made to fail on read.
 *
 * The order is part of the contract: a depth-first pre-order walk whose entries
 * at each level — files and subdirectories interleaved — are visited sorted by
 * name using a plain code-unit comparison, never a locale-aware one. The same
 * tree therefore yields the same sequence on every machine and locale, so a
 * diagnostic's position in the output is stable too.
 */
export function sourceFiles(dir, skip) {
  const files = [];
  collect(dir, skip, files);
  return files;
}

function collect(dir, skip, files) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collect(path, skip, files);
      }
    } else if (/\.tsx?$/.test(entry.name) && !skip(entry.name) && isRegularFile(path, entry)) {
      files.push(path);
    }
  }
}

/**
 * Whether the entry at `path` leads to a regular file. `readdirSync` reports a
 * symlink as the link itself, so the link has to be followed to see a file
 * behind it; `throwIfNoEntry: false` makes a link with no target report no
 * stat, which leaves it out of the walk instead of throwing on it.
 *
 * A stat the filesystem refuses leaves the path out the same way. A pair of
 * links that point at each other fails with `ELOOP`, which `throwIfNoEntry`
 * does not cover; admitting the path would hand every audit a file nobody can
 * read, and letting the error out would end the walk the audit was making.
 */
function isRegularFile(path, entry) {
  if (entry.isFile()) {
    return true;
  }
  let target;
  try {
    target = statSync(path, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  return target?.isFile() === true;
}

/**
 * One source file, parsed and named the way the walk below does it: its
 * absolute path `file`, the normalised path `path` a diagnostic names it by,
 * its `text`, its syntax tree `program`, one `problems` line per parse error,
 * and `lineOf`, the offset-to-line lookup the parse problems were built with,
 * so a caller reuses it instead of scanning the text again.
 *
 * `text` is the caller's, so a caller that already holds the text — an audit
 * whose rules take the source it was given — parses it through the same step
 * the walk uses. Paths are named from `root`; a file outside it — a fixture
 * tree in a temporary directory — is named from `dir`.
 */
export function parseSourceEntry(dir, root, file, text) {
  const { program, errors } = parseSourceFile(file, text);
  const fromRoot = relativePath(root, file);
  const path = (fromRoot.startsWith('..') ? relativePath(dir, file) : fromRoot)
    .split(sep)
    .join('/');
  const lineOf = lineIndex(text);
  return {
    file,
    path,
    text,
    program,
    lineOf,
    problems: parseProblems(path, errors, lineOf),
  };
}

/**
 * Every source file below `dir`, read and parsed once, one file at a time, each
 * as one `parseSourceEntry`.
 *
 * The walk is a generator, so a caller's `for … of` holds one file's text and
 * one syntax tree at a time. The matched path list is collected before the
 * first yield, so memory is the parsed file plus that list.
 *
 * A file the parser refused has an empty tree, so the keys or calls it holds
 * would leave an audit without a word. `problems` says what the parser stopped
 * at instead, and a caller must report every line of it: an unaudited file is
 * not a clean one.
 *
 * A read the filesystem refuses yields an entry whose single problem line names
 * the path and the error, and the walk continues. An audit must report a file
 * it could not read rather than drop it, and one refusal must not discard the
 * findings the walk already collected.
 */
export function* parseSourceTree(dir, root, skip) {
  for (const file of sourceFiles(dir, skip)) {
    yield readSourceEntry(dir, root, file);
  }
}

/**
 * One walked file read and parsed. A refused read still yields the entry's
 * shared shape — the path, an empty text, and an empty tree — so the caller
 * meets one problem line where it would have read the file's own findings.
 */
function readSourceEntry(dir, root, file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = parseSourceEntry(dir, root, file, '');
    return { ...entry, problems: [`${entry.path}: cannot read: ${message}`] };
  }
  return parseSourceEntry(dir, root, file, text);
}
