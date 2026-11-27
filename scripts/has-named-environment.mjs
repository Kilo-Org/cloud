// Exits 0 when a wrangler.jsonc defines its own `env.<name>` object, 1 when it
// does not, and 2 when the arguments, the file or its JSONC cannot be read.
// Zero-install: deploy jobs run it before any dependency is installed.
//
// Usage: node scripts/has-named-environment.mjs <wrangler.jsonc> <environment>
//
// A named environment only stops Wrangler from falling back to the top-level
// (production) configuration; it says nothing about whether its bindings are
// isolated from production.
import { readFileSync } from 'node:fs';

// Converts JSONC to JSON in one string-aware pass: a comment becomes whitespace
// (so the tokens around it stay apart), a trailing comma before `}` or `]` is
// dropped only outside strings, and an unterminated block comment is an error.
function jsoncToJson(value) {
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

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const [file, environment, ...extra] = process.argv.slice(2);
if (!file || !environment || extra.length > 0) {
  console.error('Usage: has-named-environment.mjs <wrangler.jsonc> <environment>');
  process.exit(2);
}

let config;
try {
  const raw = readFileSync(file, 'utf8');
  config = JSON.parse(jsoncToJson(raw));
} catch {
  console.error(`Cannot read ${file} as JSONC`);
  process.exit(2);
}

process.exit(
  isObject(config) &&
    isObject(config.env) &&
    Object.hasOwn(config.env, environment) &&
    isObject(config.env[environment])
    ? 0
    : 1
);
