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
 * A template literal is opaque whole: `${…}` may nest another template, so
 * `endOfTemplate` follows the interpolation's own brackets, strings and
 * comments to the literal's closing backtick. `endOfQuoted` answers a narrower
 * question — where the next unescaped quote is — and is only safe for a run
 * that cannot contain an interpolation. `endOfQuotedOrComment` is the one test
 * a scanning loop needs, and it takes the template-aware path for a backtick.
 */

/**
 * The index just past the JS string starting at `start`. Only the matching
 * quote character ends the run: a template literal's `${…}` is not
 * interpreted, so callers holding a backtick use `endOfTemplate` instead. An
 * unterminated run ends at the end of the text.
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
 * The index just past the template literal starting at `start`, across its
 * `${…}` interpolations: an interpolation is walked as code, so a nested
 * template, string or comment inside it is skipped whole and only the `}` that
 * closes it ends the expression. The literal's own backtick then ends the run.
 * An unterminated run ends at the end of the text.
 */
export function endOfTemplate(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      return index + 1;
    }
    if (char === '$' && text[index + 1] === '{') {
      const end = endOfInterpolation(text, index + 2);
      if (end === -1) {
        return text.length;
      }
      index = end;
      continue;
    }
    index++;
  }
  return text.length;
}

/**
 * The index just past the `}` closing the interpolation whose expression starts
 * at `start`, or -1 when the text ends first. Brackets, strings, templates and
 * comments are balanced inside the expression, so a `}` in any of them is text.
 */
function endOfInterpolation(text, start) {
  let depth = 1;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = endOfQuoted(text, index);
      continue;
    }
    if (char === '`') {
      index = endOfTemplate(text, index);
      continue;
    }
    if (char === '/') {
      const comment = endOfComment(text, index);
      if (comment !== -1) {
        index = comment;
        continue;
      }
    }
    if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return index + 1;
    }
    index++;
  }
  return -1;
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
 * The index just past the quoted run, template literal or comment starting at
 * `start`, or -1 when `start` begins none. The one test a scanning loop needs
 * before applying its own depth rule: a backtick run is skipped whole, its
 * `${…}` interpolations included, so an apostrophe or a bracket inside one
 * never reaches the caller's loop.
 */
export function endOfQuotedOrComment(text, start) {
  const char = text[start];
  if (char === '"' || char === "'") {
    return endOfQuoted(text, start);
  }
  if (char === '`') {
    return endOfTemplate(text, start);
  }
  if (char === '/') {
    return endOfComment(text, start);
  }
  return -1;
}
