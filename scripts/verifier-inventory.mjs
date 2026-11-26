// Finds the production source that checks a credential, for the phase 4 surface
// inventory (design section 9.6). verifier-inventory.test.mjs classifies every
// hit: a hit inside a listed surface passes, and any other hit needs an exact
// file exception, so a new verifier fails the test until a decision lists it.
//
// The scan is a set of conservative source patterns, not a parser:
// - a line whose first non-blank characters are `//`, `/*` or `*` is a comment
//   and is skipped; any other line counts, so the scan over-counts rather than
//   misses;
// - `primitive`: a signature, token or constant-time check (`jwtVerify`,
//   `compactVerify`, `flattenedVerify`, `generalVerify`, `jwtDecrypt`,
//   `compactDecrypt`, `jwt.verify`, `subtle.verify`, `timingSafeEqual`), whatever
//   key set or secret it uses;
// - `oauth-provider`: an own OAuth server (`new OAuthProvider`);
// - `helper-call`: a call of a shared legacy verifier (LEGACY_HELPERS);
// - `helper-import`: a value import of a shared legacy verifier from its package,
//   at the package root or a subpath, under any local alias. Consumers of
//   worker-utils and auto-routing-contracts are found only through
//   LEGACY_HELPERS: a new verifier exported there must join that list, or its
//   callers are not hits;
// - `web-shared-import`: a value import of `@kilocode/web-shared`, root or any
//   subpath, from outside web-shared itself. The package holds the web app's
//   request authentication, so only the two apps of rows 1 and 2 use it freely;
// - `auth-library-import`: a value import that can verify a token: `hono/jwt`,
//   `hono/jwk`, `hono/utils/jwt` and its subpaths, `hono/bearer-auth`,
//   `hono/basic-auth`; the default or namespace binding of
//   `jose` or `jsonwebtoken`; a named `jose` verify or decrypt function or the
//   named `verify` of `jsonwebtoken`, under any alias. Sign-only named imports
//   (`SignJWT`, `sign`, `decodeJwt`) are not hits;
// - `verify-library`: a value import of `@kilocode/verify`;
// - `plain-secret-compare`, a heuristic: `===` or `!==` between a value and an
//   `env.*_SECRET`, `env.*_TOKEN` or `env.*_KEY` binding, in a file that reads an
//   inbound request header or bearer.
// A credential the code only sends, and a bearer tested only for presence, are
// not hits.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const LEGACY_HELPERS = [
  'verifyKiloToken',
  'verifyKiloTokenForResource',
  'verifyKiloTokenForPolicy',
  'verifyKiloSessionForPolicy',
  'verifyKiloTokenSignature',
  'verifyKiloBearerAgainstCurrentPepper',
  'verifyKiloBearerOrInternalAssertionAgainstCurrentPepper',
  'verifyCallbackToken',
  'verifyRuntimeProxyAttestation',
  'verifyAutoDecision',
  'unsealRuntimeAuthorization',
  'backendAuthMiddleware',
  'getUserFromAuth',
  'getUserFromAuthOrRedirect',
  'validateAuthorizationHeader',
];

// The packages that export LEGACY_HELPERS.
const HELPER_PACKAGE = /^@kilocode\/(?:worker-utils|web-shared|auto-routing-contracts)(?:\/|$)/;
const VERIFY_LIBRARY = /^@kilocode\/verify(?:\/|$)/;
const WEB_SHARED = /^@kilocode\/web-shared(?:\/|$)/;
const WEB_SHARED_DIR = 'packages/web-shared';
const HONO_AUTH = /^hono\/(?:jwt|jwk|bearer-auth|basic-auth|utils\/jwt(?:\/[^/]+)*)$/;
const VERIFYING_NAMES = new Map([
  [
    'jose',
    new Set([
      'jwtVerify',
      'compactVerify',
      'flattenedVerify',
      'generalVerify',
      'jwtDecrypt',
      'compactDecrypt',
      'flattenedDecrypt',
      'generalDecrypt',
    ]),
  ],
  ['jsonwebtoken', new Set(['verify'])],
]);

const HELPER_NAMES = new Set(LEGACY_HELPERS);
const LINE_SIGNALS = [
  [
    'primitive',
    /\b(?:jwtVerify|compactVerify|flattenedVerify|generalVerify|jwtDecrypt|compactDecrypt|timingSafeEqual)\s*\(|\bjwt\s*\.\s*verify\s*\(|\bsubtle\s*\.\s*verify\s*\(/g,
  ],
  ['oauth-provider', /\bnew\s+OAuthProvider\b/g],
  ['helper-call', new RegExp(`\\b(?:${LEGACY_HELPERS.join('|')})\\s*(?:<[^()]*>)?\\s*\\(`, 'g')],
];
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const INBOUND = /\bheaders\s*\.\s*get\s*\(|\.\s*header\s*\(|\bextractBearerToken\s*\(/;
const PLAIN_SECRET_COMPARE =
  /[\w$)\]]\s*[!=]==\s*(?:[\w$]+\.)*env\.[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY)\b|\benv\.[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY)\s*[!=]==\s*(?!undefined\b|null\b|['"`])[\w$]/g;
const IMPORT =
  /(?:^|[;\n])[ \t]*(?:import|export)\s+(type\s+)?([^;]*?)\s*\bfrom\s*['"]([^'"\n]+)['"]/g;

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Not production: type declarations; `*.test.*`, `*.spec.*` and `*.stories.*`
// files; anything under a directory named `test`, `tests`, `__tests__`,
// `__mocks__`, `fixtures`, `e2e` or `scripts`; and test setup or runner config
// files (`*test-setup*`, `vitest.config*`, `vitest.setup*`, `playwright.config*`).
const NOT_PRODUCTION = [
  /\.d\.ts$/,
  /\.(?:test|spec|stories)\.[^/]+$/,
  /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures|e2e|scripts)\//,
  /(?:^|\/)[^/]*(?:test-setup|vitest\.(?:config|setup)|playwright\.config)[^/]*$/,
];

export function isProductionFile(file) {
  return SOURCE_FILE.test(file) && !NOT_PRODUCTION.some(pattern => pattern.test(file));
}

const callName = match => match.replace(/\s*(?:<[^()]*>)?\s*\($/, '').replace(/\s+/g, ' ');

// The hits of one source file: [{ kind, line, detail }].
export function fileSignals(text) {
  const lines = text.split('\n').map(line => (COMMENT_LINE.test(line) ? '' : line));
  const signals = [];
  lines.forEach((line, index) => {
    for (const [kind, pattern] of LINE_SIGNALS) {
      for (const match of line.matchAll(pattern)) {
        signals.push({ kind, line: index + 1, detail: callName(match[0]) });
      }
    }
  });
  const code = lines.join('\n');
  if (INBOUND.test(code)) {
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PLAIN_SECRET_COMPARE)) {
        signals.push({ kind: 'plain-secret-compare', line: index + 1, detail: match[0] });
      }
    });
  }
  for (const match of code.matchAll(IMPORT)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly) continue;
    const line = code.slice(0, match.index + match[0].search(/\S/)).split('\n').length;
    const braces = clause.match(/\{([^}]*)\}/);
    const names = (braces?.[1] ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(item => item && !item.startsWith('type '))
      .map(item => item.split(/\s+as\s+/)[0].trim());
    // A default or namespace binding can reach every export of the module.
    const whole = !clause.trim().startsWith('{');
    const verifying = VERIFYING_NAMES.get(specifier);
    if (VERIFY_LIBRARY.test(specifier)) {
      signals.push({ kind: 'verify-library', line, detail: specifier });
    } else if (WEB_SHARED.test(specifier)) {
      signals.push({ kind: 'web-shared-import', line, detail: specifier });
    } else if (
      HONO_AUTH.test(specifier) ||
      (verifying && (whole || names.some(name => verifying.has(name))))
    ) {
      signals.push({ kind: 'auth-library-import', line, detail: specifier });
    }
    const helpers = HELPER_PACKAGE.test(specifier)
      ? names.filter(name => HELPER_NAMES.has(name))
      : [];
    if (helpers.length > 0) {
      signals.push({
        kind: 'helper-import',
        line,
        detail: `${helpers.join(',')} from ${specifier}`,
      });
    }
  }
  return signals;
}

// The workspace patterns of pnpm-workspace.yaml. Only a literal directory or a
// literal directory followed by `/*` is supported; anything else throws, so the
// scan never silently misses a workspace.
export function workspacePatterns(workspaceYaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of workspaceYaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (inPackages && /^\s+-\s+/.test(line)) {
      patterns.push(
        line
          .replace(/^\s+-\s+/, '')
          .replace(/^(['"])(.*)\1$/, '$2')
          .trim()
      );
    } else if (inPackages && /^\S/.test(line)) inPackages = false;
  }
  for (const pattern of patterns) {
    if (!/^[\w.@-]+(?:\/[\w.@-]+)*(?:\/\*)?$/.test(pattern)) {
      throw new Error(`unsupported pnpm workspace pattern: ${pattern}`);
    }
  }
  return patterns;
}

// The workspace directories: tracked manifests that a pattern matches.
export function workspaceDirs(patterns, files) {
  return files
    .filter(file => file.endsWith('/package.json'))
    .map(file => posix.dirname(file))
    .filter(dir => patterns.some(pattern => posix.matchesGlob(dir, pattern)))
    .sort();
}

function ownerOf(dirs, file) {
  let best = null;
  for (const dir of dirs) {
    if (file.startsWith(`${dir}/`) && (!best || dir.length > best.length)) best = dir;
  }
  return best;
}

// Every hit in the production files of `files`, with its owning workspace, or
// null when no workspace owns the file. Web-shared's imports of itself are not
// hits.
export function scanRepository({ files, readFile, workspaces }) {
  const found = [];
  for (const file of files) {
    if (!isProductionFile(file)) continue;
    const workspace = ownerOf(workspaces, file);
    for (const signal of fileSignals(readFile(file))) {
      if (signal.kind === 'web-shared-import' && workspace === WEB_SHARED_DIR) continue;
      found.push({ ...signal, file, workspace });
    }
  }
  return found;
}

// The live repository: the tracked files under the workspace roots, the
// workspaces and their hits.
export function scanLiveRepository(root) {
  const read = file => readFileSync(posix.join(root, file), 'utf8');
  const patterns = workspacePatterns(read('pnpm-workspace.yaml'));
  const roots = [...new Set(patterns.map(pattern => pattern.split('/')[0]))];
  const files = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  const workspaces = workspaceDirs(patterns, files);
  return { files, workspaces, signals: scanRepository({ files, readFile: read, workspaces }) };
}

function countKinds(signals) {
  const counts = {};
  for (const { kind } of signals) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

const inside = (file, dirs) => dirs.some(dir => file.startsWith(`${dir}/`));

// The inventory rule. A hit passes inside `surfaceDirs` (the listed surfaces)
// or `excludedDirs` (KiloClaw). Any other file with hits must have an exception
// whose per-kind counts match exactly and whose pinned strings it still holds;
// an exception without hits is stale. Returns one message per problem.
export function inventoryViolations({ signals, surfaceDirs, excludedDirs, exceptions, readFile }) {
  const byFile = new Map();
  for (const signal of signals) {
    if (inside(signal.file, surfaceDirs) || inside(signal.file, excludedDirs)) continue;
    byFile.set(signal.file, [...(byFile.get(signal.file) ?? []), signal]);
  }
  const violations = [];
  for (const [file, list] of byFile) {
    const where = list
      .slice(0, 3)
      .map(({ line, kind, detail }) => `${file}:${line} ${kind} ${detail}`)
      .join('; ');
    const exception = exceptions[file];
    if (list[0].workspace === null) {
      violations.push(`${file} checks a credential outside every workspace (${where})`);
    } else if (!exception) {
      violations.push(
        `${list[0].workspace} checks a credential (${where}) but is not in design section 9.6; list it through a decision, or add an exact exception with its reason`
      );
    } else {
      const counts = countKinds(list);
      if (!isDeepStrictEqual(counts, exception.signals)) {
        violations.push(
          `${file}: hits ${JSON.stringify(counts)} differ from its exception ${JSON.stringify(exception.signals)} (${where}); update the exception's reason and counts, and add a newly exported verifier to LEGACY_HELPERS`
        );
      }
      const text = readFile(file);
      for (const pin of exception.pins ?? []) {
        if (!text.includes(pin)) violations.push(`${file}: no longer contains ${pin}`);
      }
    }
  }
  for (const file of Object.keys(exceptions)) {
    if (!byFile.has(file)) violations.push(`${file}: the exception matches no hit; remove it`);
  }
  return violations;
}
