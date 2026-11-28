// Converts JSONC (wrangler.jsonc) to JSON with no dependency, so deploy jobs can read a Worker
// config before any install (scripts/has-named-environment.mjs, scripts/ci/inherit-secret-bindings.mjs).

// Converts JSONC to JSON in one string-aware pass: a comment becomes whitespace
// (so the tokens around it stay apart), a trailing comma before `}` or `]` is
// dropped only outside strings, and an unterminated block comment is an error.
export function jsoncToJson(value) {
  let output = '';
  let inString = false;
  let escaped = false;
  let pendingComma = -1;
  let previous = '';

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }

    if (current === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end === -1) throw new Error('unterminated block comment');
      output += ' ';
      index = end + 1;
      continue;
    }

    if ((current === '}' || current === ']') && pendingComma !== -1) {
      output = output.slice(0, pendingComma) + output.slice(pendingComma + 1);
    }
    // Only a comma after a value may trail: `[,]`, `{,}`, `:,` and `,,` stay malformed.
    if (current === ',') pendingComma = '[{:,'.includes(previous) ? -1 : output.length;
    else if (!/\s/.test(current)) pendingComma = -1;
    if (!/\s/.test(current)) previous = current;
    if (current === '"') inString = true;
    output += current;
  }

  return output;
}
