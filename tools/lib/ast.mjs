/**
 * The syntax tree the mobile audits share.
 *
 * A rule that reads JSX attributes, imports, call arguments or template
 * literals has to know what the text is: a string, a template chunk, a
 * comment, a type annotation. Walking the characters to find out is what used
 * to desynchronise the audits — a comma or an apostrophe inside a comment or a
 * nested template could read as code, and a call site then dropped out of the
 * audit silently. Oxc parses the file once and answers that question
 * correctly, so every rule below it reads nodes.
 *
 * The parser is the engine oxlint already runs in this repository. It is
 * dev-only: nothing here reaches the app bundle.
 */
import { parseSync } from 'oxc-parser';

/**
 * Parse one audited source file. The path carries the language, so `.tsx` is
 * read as TSX and `.ts` as TS; the audits only see those two extensions.
 *
 * Oxc hands back the tree together with the errors it found. A syntax error
 * aborts the tree — the program is then empty, not partial — so a caller must
 * report every error instead of reading the file as clean.
 */
export function parseSourceFile(relative, text) {
  const { program, errors } = parseSync(relative, text);
  return { program, errors };
}

/**
 * Every node below `node`, in source order, each visited before its children.
 * Node positions (`start`, `end`) and the node kind (`type`) stay on the node;
 * everything else that is an object is a child, so a rule never has to know
 * the shape of the node it is looking through.
 */
export function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (typeof node.type === 'string') {
    visit(node);
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') {
      continue;
    }
    const value = node[key];
    if (value !== null && typeof value === 'object') {
      walk(value, visit);
    }
  }
}

/**
 * The 1-based line of any offset in `text`. A diagnostic names the line its
 * node starts on, and the rules map a match inside one string or template
 * chunk back through the chunk's own offset, so the line is computed once from
 * the line starts instead of once per lookup.
 */
export function lineIndex(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low + 1;
  };
}

/**
 * One problem line per parse error: the file and line the parser stopped at,
 * and its message. An audit that cannot read a file must say so — the finding
 * it would have made is otherwise indistinguishable from a clean file.
 */
export function parseProblems(relative, errors, lineOf) {
  return errors.map(error => {
    const start = error.labels?.[0]?.start ?? 0;
    return `${relative}:${lineOf(start)}: cannot parse: ${error.message}`;
  });
}
