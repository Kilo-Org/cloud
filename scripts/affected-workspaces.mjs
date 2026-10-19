#!/usr/bin/env node
// Select the workspaces whose typecheck and lint results a change can alter.
//
// Usage: node scripts/affected-workspaces.mjs <base-sha>
// Prints JSON: { full, reasons, full_checks, dirs, packages, test_only_dirs,
// test_only_packages, test_only_files }.
//
// A workspace is affected when one of its files changed, or when it reads an
// affected workspace. A workspace reads another through a workspace:* entry in
// its package.json, or through a relative path (an import, a tsconfig `paths`
// or `include` entry, a config alias) that reaches into the other workspace. A
// workspace also reads every workspace nested inside it. A change that this
// script cannot attribute to a workspace selects everything (`full: true`).
//
// A test file that reads another workspace's files as data (a relative path
// that is not a module specifier) does not make its workspace affected: the
// data cannot change its types, lint results or exports. When a file in the
// workspace it reads changes, only the reader's tests need to run
// (`test_only_*`), and nothing that reads the reader follows.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

// Root paths that change how every workspace is checked.
const GLOBAL = [
  /^(package\.json|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|\.nvmrc|\.oxlintrc\.json|\.oxfmtrc\.json|oxlint-plugin-drizzle\.js|tsconfig[^/]*\.json)$/,
  /^(patches|tools\/oxlint)\//,
  /^\.github\/workflows\/(ci|kilo-app-ci)\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/(affected-workspaces\.mjs|changed-dependencies\.mjs|trpc-declaration-key\.mjs)$/,
];

// Root scripts that change one check for every workspace, and nothing else.
const CHECK_SCRIPTS = [
  [/^scripts\/typecheck-all\.sh$/, 'typecheck'],
  [/^scripts\/lint-all\.sh$/, 'lint'],
];

// Root paths whose effect belongs to one workspace.
const OWNED = [
  [/^scripts\/web-env\//, 'apps/web'],
  [/^tools\/(i18n|nativewind)\//, 'apps/mobile'],
];

// [pattern, workspace]: files whose change also affects a workspace, beyond
// the workspace that owns the file.
const EXTRA_INPUTS = [
  // The ai-gateway build copies these web app files (the build-ai-gateway job
  // in ci.yml).
  [/^apps\/web\/\.env(\.test)?$/, 'apps/ai-gateway'],
];

// Root paths that no typecheck or lint reads.
const NEUTRAL = [
  /\.md$/,
  /^(\.specs|\.plans|docs|dev|\.kilo|\.agents|\.vscode|\.husky|\.cursor|script|\.github|scripts)\//,
  /^(LICENSE|skills-lock\.json|kilo\.json|flake\.nix|flake\.lock|\.syft\.yaml|\.gitignore|\.gitattributes|\.envrc|\.kilocodeignore|\.prettierignore|\.env\.local\.example)$/,
];

const SOURCE_GLOBS = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'jsonc'];

const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/;

// Calls whose first argument is a module specifier.
const MODULE_CALLS = new Set([
  'import',
  'require',
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'requireActual',
  'requireMock',
]);

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function workspaces() {
  const list = JSON.parse(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  const root = process.cwd();
  return list
    .map(item => {
      const dir = posix.relative(root, item.path);
      const manifest = dir ? JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) : {};
      return { name: item.name, dir, manifest };
    })
    .filter(item => item.dir !== '');
}

function owner(dirs, file) {
  let best = null;
  for (const dir of dirs) {
    if ((file === dir || file.startsWith(`${dir}/`)) && (!best || dir.length > best.length)) {
      best = dir;
    }
  }
  return best;
}

// Whether the quoted literal at `index` is a module specifier: it follows
// `from` or `import`, or it is the first argument of a MODULE_CALLS call, with
// optional comments and a type argument (`importActual<typeof import('x')>('x')`).
export function isModuleSpecifier(text, index) {
  let i = index - 1;
  const skipTrivia = () => {
    while (i >= 0) {
      if (/\s/.test(text[i])) {
        i--;
      } else if (text[i] === '/' && text[i - 1] === '*') {
        const start = text.lastIndexOf('/*', i - 2);
        if (start < 0) break;
        i = start - 1;
      } else {
        const start = Math.max(text.lastIndexOf('\n', i), text.lastIndexOf('\r', i)) + 1;
        const line = text.slice(start, i + 1);
        const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\*.*?\*\/|\/\/.*/g;
        const comment = [...line.matchAll(tokens)].find(token => token[0].startsWith('//'));
        if (!comment) break;
        i = start + comment.index - 1;
      }
    }
  };
  skipTrivia();
  const call = text[i] === '(';
  if (call) {
    i--;
    skipTrivia();
    if (text[i] === '>' && text[i - 1] !== '=') {
      for (let depth = 0; i >= 0; i--) {
        if (text[i] === '>' && text[i - 1] !== '=') depth++;
        else if (text[i] === '<' && --depth === 0) break;
      }
      i--;
      skipTrivia();
    }
  }
  const end = i + 1;
  while (i >= 0 && /[\w$]/.test(text[i])) i--;
  const word = text.slice(i + 1, end);
  return call ? MODULE_CALLS.has(word) : word === 'from' || word === 'import';
}

// [file, repository path, read as a path] for every quoted relative path in
// workspace sources. The last item is false for a module specifier.
function relativeReferences(dirs) {
  let out = '';
  try {
    out = git(
      'grep',
      '-I',
      '-l',
      '-z',
      '-E',
      `['"](\\.\\./)+[^'"\`$ ]*['"]`,
      '--',
      ...dirs.flatMap(dir => SOURCE_GLOBS.map(ext => `${dir}/*.${ext}`))
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const references = [];
  for (const file of out.split('\0').filter(Boolean)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/['"]((?:\.\.\/)+[^'"`$ \n]*)['"]/g)) {
      const literal = match[1].split('*')[0];
      const target = posix.normalize(posix.join(posix.dirname(file), literal)).replace(/\/$/, '');
      if (target.startsWith('..')) continue;
      references.push([file, target, !isModuleSpecifier(text, match.index)]);
    }
  }
  return references;
}

export function selectAffected({ items, changedFiles, lockfileDirs, references }) {
  const dirs = items.map(item => item.dir);
  const dirOf = new Map(items.map(item => [item.name, item.dir]));
  const nameOf = new Map(items.map(item => [item.dir, item.name]));
  // readers.get(x): workspaces that read workspace x
  const readers = new Map(dirs.map(dir => [dir, new Set()]));
  const read = (reader, dir) => {
    if (reader && dir && reader !== dir) readers.get(dir).add(reader);
  };
  for (const { dir, manifest } of items) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (String(version).startsWith('workspace:')) read(dir, dirOf.get(name));
      }
    }
    read(
      owner(
        dirs.filter(other => other !== dir),
        dir
      ),
      dir
    );
  }
  // Root paths (outside every workspace) that a workspace reads, with the test
  // file that reads it as data, if one does.
  const rootReads = [];
  // [reader, workspace, test file]: the test file reads the workspace's files
  // as data.
  const testReads = [];
  for (const [file, target, asPath] of references) {
    const from = owner(dirs, file);
    const to = owner(dirs, target);
    const testFile = asPath && TEST_FILE.test(file) ? file : null;
    if (to && testFile) testReads.push([from, to, file]);
    else if (to) read(from, to);
    else if (from) rootReads.push([target, from, testFile]);
  }
  // [reader, test file]: the test file reads changed data.
  const tested = [];

  const reasons = [];
  const fullChecks = new Set();
  const changed = new Set();
  for (const file of changedFiles) {
    const dir = owner(dirs, file);
    if (dir) {
      if (!file.endsWith('.md')) changed.add(dir);
      for (const [reader, workspace, testFile] of testReads) {
        if (file.startsWith(`${workspace}/`)) tested.push([reader, testFile]);
      }
      for (const [pattern, reader] of EXTRA_INPUTS) {
        if (pattern.test(file) && readers.has(reader)) changed.add(reader);
      }
      continue;
    }
    if (GLOBAL.some(pattern => pattern.test(file))) {
      reasons.push(`${file} changes how every workspace is checked`);
      continue;
    }
    const script = CHECK_SCRIPTS.find(([pattern]) => pattern.test(file));
    if (script) {
      fullChecks.add(script[1]);
      continue;
    }
    if (file === 'pnpm-lock.yaml') {
      if (lockfileDirs.includes('*') || lockfileDirs.includes('.')) {
        reasons.push('pnpm-lock.yaml changes root or unscoped dependencies');
      }
      for (const lockDir of lockfileDirs) if (readers.has(lockDir)) changed.add(lockDir);
      continue;
    }
    const rootReaders = rootReads.filter(
      ([target]) => file === target || file.startsWith(`${target}/`)
    );
    for (const [, reader, testFile] of rootReaders) {
      if (testFile) tested.push([reader, testFile]);
      else changed.add(reader);
    }
    const owned = OWNED.find(([pattern]) => pattern.test(file));
    if (owned) changed.add(owned[1]);
    if (owned || rootReaders.length || NEUTRAL.some(pattern => pattern.test(file))) continue;
    reasons.push(`${file} is outside every workspace`);
  }

  const full = reasons.length > 0;
  const affected = new Set(full ? dirs : []);
  const queue = full ? [] : [...changed];
  while (queue.length) {
    const dir = queue.pop();
    if (affected.has(dir)) continue;
    affected.add(dir);
    queue.push(...readers.get(dir));
  }
  // Workspaces that only need their tests run, with the test files that read
  // changed data.
  const testOnly = new Map();
  for (const [reader, file] of tested) {
    if (reader && !affected.has(reader)) {
      testOnly.set(reader, (testOnly.get(reader) ?? new Set()).add(file));
    }
  }
  return {
    full,
    reasons,
    // Checks that must cover every workspace, even when `full` is false.
    full_checks: full ? ['lint', 'typecheck'] : [...fullChecks].sort(),
    dirs: [...affected].sort(),
    packages: [...affected].map(dir => nameOf.get(dir)).sort(),
    test_only_dirs: [...testOnly.keys()].sort(),
    test_only_packages: [...testOnly.keys()].map(dir => nameOf.get(dir)).sort(),
    test_only_files: [...testOnly.values()].flatMap(files => [...files]).sort(),
  };
}

if (import.meta.main) {
  const base = process.argv[2] ?? '';
  const items = workspaces();
  const valid =
    /^[0-9a-f]{40}$/.test(base) &&
    (() => {
      try {
        git('cat-file', '-e', `${base}^{commit}`);
        return true;
      } catch {
        return false;
      }
    })();
  const changedFiles = valid
    ? git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
    : ['<no base revision>'];
  const lockfileDirs = changedFiles.includes('pnpm-lock.yaml')
    ? execFileSync('node', ['scripts/changed-dependencies.mjs', base], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    : [];
  const references = valid ? relativeReferences(items.map(item => item.dir)) : [];
  console.log(JSON.stringify(selectAffected({ items, changedFiles, lockfileDirs, references })));
}
