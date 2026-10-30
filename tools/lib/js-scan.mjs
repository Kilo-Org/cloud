/**
 * The scanning primitives the mobile audit tools share.
 *
 * Both tools walk JS source by hand, and both have to step over the regions
 * where a bracket, a comma, a quote or an arrow is just text: a string or
 * template literal, and a comment. Only the terminator is a rule of its own —
 * `{}` nesting, a depth-0 comma, a depth-0 `>` — so it stays at each call site
 * and everything opaque about the text lives here.
 *
 * Comments count in both forms. A `//` skip alone leaves a `/* … *\/` body
 * readable as code, so a comma or an apostrophe inside one desynchronises the
 * caller's loop and a whole call site silently drops out of the audit.
 *
 * Template-literal `${…}` interpolations are not interpreted here: this module
 * reports where the literal ends. A caller that needs the expression inside an
 * interpolation walks it itself.
 */

/**
 * The index just past the JS string or template literal starting at `start`.
 * An unterminated run ends at the end of the text.
 */
export function endOfQuoted(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === '\\' ? 2 : 1;
  }
  return Math.min(index + 1, text.length);
}

/**
 * The index just past the line or block comment at `start`, or -1 when `start`
 * opens no comment.
 */
export function endOfComment(text, start) {
  if (text[start] !== '/') {
    return -1;
  }
  if (text[start + 1] === '/') {
    const end = text.indexOf('\n', start);
    return end === -1 ? text.length : end;
  }
  if (text[start + 1] === '*') {
    const end = text.indexOf('*/', start + 2);
    return end === -1 ? text.length : end + 2;
  }
  return -1;
}

/**
 * The index just past the quoted run or comment starting at `start`, or -1 when
 * `start` begins neither. The one test a scanning loop needs before applying
 * its own depth rule.
 */
export function endOfQuotedOrComment(text, start) {
  const char = text[start];
  if (char === '"' || char === "'" || char === '`') {
    return endOfQuoted(text, start);
  }
  if (char === '/') {
    return endOfComment(text, start);
  }
  return -1;
}
