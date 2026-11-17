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
 * Every node below `node`, each visited before its children. Children are
 * visited in source order, so a rule that reports what it finds reports it top
 * to bottom: the tree groups them by field (a template's chunks before its
 * interpolations), which is not the order they are written in.
 *
 * Node positions (`start`, `end`) and the node kind (`type`) stay on the node;
 * everything else that is an object is a child, so a rule never has to know
 * the shape of the node it is looking through.
 */
export function walk(node, visit) {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (typeof node.type === 'string') {
    visit(node);
  }
  const children = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child !== null && typeof child === 'object') {
          children.push(child);
        }
      }
    } else if (value !== null && typeof value === 'object') {
      children.push(value);
    }
  }
  children.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  for (const child of children) {
    walk(child, visit);
  }
}

/**
 * Whether `callee` is the translation function the copy audits read: a bare
 * `t`, or the initialised instance's `i18n.t`. A method of another object is a
 * different function that happens to be named `t`, so its arguments say nothing
 * about a message.
 */
export function isTranslateCallee(callee) {
  if (callee.type === 'Identifier') {
    return callee.name === 't';
  }
  if (callee.type !== 'MemberExpression' || callee.computed) {
    return false;
  }
  return (
    callee.property.type === 'Identifier' &&
    callee.property.name === 't' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'i18n'
  );
}

/**
 * The statically readable name of one object-literal property: an `Identifier`
 * key, or a string `Literal` key, and nothing else. A member that is not a
 * `Property` — a spread — declares no key, and neither does a computed key: it
 * holds an expression, so its name is whatever that expression evaluates to when
 * the object is built, which no rule can read here.
 */
export function propertyName(property) {
  if (property.type !== 'Property' || property.computed) {
    return null;
  }
  const { key } = property;
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  return null;
}

/** The wrapper nodes that only hold an expression, so a rule reads through them. */
const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'ParenthesizedExpression',
]);

/**
 * The node a TypeScript-only wrapper holds, so `{ … } satisfies X` reads as an
 * object and `'key' as const` reads as a string. The parser drops parentheses
 * by default; the entry for them holds if a caller ever keeps them.
 */
export function unwrap(node) {
  let current = node;
  while (TS_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
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
