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

import { jsoncToJson } from './jsonc.mjs';

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
