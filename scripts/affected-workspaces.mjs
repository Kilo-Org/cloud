#!/usr/bin/env node
// Select the workspaces whose typecheck and lint results a change can alter.
//
// Usage: node scripts/affected-workspaces.mjs <base-sha> [--worktree]
//        node scripts/affected-workspaces.mjs --groups
// Prints JSON: { base, base_valid, full, reasons, full_checks, dirs, packages,
// test_only_dirs, test_only_packages, test_only_files }, where `base` is the
// revision the selection was computed for and `base_valid` is false when the
// checkout could not read it, so the selection widened to every workspace
// instead of attributing the change. `dirs` is also the selection the test
// matrix consumes (scripts/changed-workspaces.sh), and `full`, `full_checks` and
// `packages` are the selection scripts/typecheck-all.sh checks, so a consumer
// reads this document instead of selecting a second time: changed-workspaces.sh
// reuses it within one CI run, and typecheck-all.sh's incremental run and its CI
// groups both decide from it. With `--worktree` the comparison covers the
// working tree instead of the committed head, so a local run selects edits that
// are not committed yet.
// With --groups it instead prints the CI matrix groups for the selection JSON on
// standard input.
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
//
// The other direction narrows the same way: a change whose files in a workspace
// are all test files selects that workspace, so its own typecheck, lint and test
// row still run, but not the workspaces that read it, because a test file cannot
// change the types the workspace exports. The narrow holds only when the
// workspace's own test script runs those files, which the test matrix requires
// before it keeps a row: a workspace without a `test` script keeps the full
// reader selection, because another workspace's runner may be the only one that
// runs its tests (a nested workspace whose parent's suite reaches into it). A
// non-test file in the same workspace, an EXTRA_INPUTS match or a dependency
// consumer keeps the full reader selection as well. A test that reads data from
// the workspace runs only when its reference reaches the changed file, because a
// changed test file is not the data it reads.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

// Root paths that change how every workspace is checked. A dependency patch is
// not one of them: its content enters the resolved closure of the workspaces
// that carry the patched selector, so it is a dependency input
// (DEPENDENCY_INPUTS below). An action is global by default: it changes the job
// that runs it rather than one workspace's sources, and a new action must not
// skip every check until a table attributes it. The single-package actions and
// their key scripts are attributed in OWNED, which is consulted first.
const GLOBAL = [
  /^(package\.json|\.npmrc|\.pnpmfile\.cjs|\.nvmrc|tsconfig[^/]*\.json)$/,
  /^\.github\/workflows\/(ci|kilo-app-ci)\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/(affected-workspaces\.mjs|changed-dependencies\.mjs|build-key-inputs\.mjs|ttsc-plugin-key\.mjs)$/,
];

// Root paths that change one check for every workspace, and nothing else: the
// scripts that run a check, and the inputs only one check reads. A lint config
// or an oxlint plugin cannot change a type program, so it selects the lint rows
// alone; every workspace is still linted. A workspace that runs its own lint
// with these inputs keeps that check: kilo-app CI names tools/oxlint in its own
// change detection, because the app's oxlint configs load those plugins.
const CHECK_INPUTS = [
  [/^scripts\/typecheck-all\.sh$/, 'typecheck'],
  [/^scripts\/lint-all\.sh$/, 'lint'],
  [/^(\.oxlintrc\.json|oxlint-plugin-drizzle\.js)$/, 'lint'],
  [/^tools\/oxlint\//, 'lint'],
];

// Root paths whose effect belongs to one workspace. Every entry here is
// consulted before GLOBAL, so it attributes a path even when a broad GLOBAL
// pattern also covers it.
const OWNED = [
  [/^scripts\/web-env\//, 'apps/web'],
  [/^tools\/(i18n|nativewind)\//, 'apps/mobile'],
  // A build action for one package, and the script that decides its cache key,
  // change that package's dist and nothing else. Either one is an input of the
  // dist key, so a change to it forces a rebuild; the package's readers follow
  // through the reader closure.
  [/^\.github\/actions\/harness-sdk-build\//, 'packages/harness-sdk'],
  [/^scripts\/harness-sdk-build-key\.mjs$/, 'packages/harness-sdk'],
  [/^\.github\/actions\/trpc-declarations\//, 'packages/trpc'],
  [/^scripts\/trpc-declaration-key\.mjs$/, 'packages/trpc'],
];

// [pattern, workspace]: files whose change also affects a workspace, beyond
// the workspace that owns the file.
const EXTRA_INPUTS = [
  // The ai-gateway build copies these web app files (the build-ai-gateway job
  // in ci.yml).
  [/^apps\/web\/\.env(\.test)?$/, 'apps/ai-gateway'],
];

// Root paths that no typecheck or lint reads. The formatter config belongs here:
// the ci.yml format-check job runs on every run, so a change to it needs no
// workspace selection.
const NEUTRAL = [
  /\.md$/,
  /^(\.specs|\.plans|docs|dev|\.kilo|\.agents|\.vscode|\.husky|\.cursor|script|\.github|scripts)\//,
  /^(LICENSE|skills-lock\.json|kilo\.json|flake\.nix|flake\.lock|\.syft\.yaml|\.gitignore|\.gitattributes|\.envrc|\.kilocodeignore|\.prettierignore|\.oxfmtrc\.json|\.env\.local\.example)$/,
];

// Paths that no check reads on its own: documents, and the root locations above
// that hold no workspace input. A suite that reads a document as data selects
// itself through `test_only_*` instead.
export function isNeutral(file) {
  return NEUTRAL.some(pattern => pattern.test(file));
}

// Dependency inputs whose effect reaches one workspace at a time through its
// resolved dependency graph (scripts/changed-dependencies.mjs): the manifests,
// and the patch content those closures carry. They select the workspaces whose
// graph moved, and everything only when the graph cannot attribute the change:
// a root or unscoped dependency, a workspace glob, an installation-policy key
// that can change the installed tree, a patch that the root importer or no
// importer resolves, or an unreadable manifest. A workspace test that reads one
// of these files as data runs that workspace's tests alone (`test_only_*`).
export const DEPENDENCY_MANIFESTS = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);

// The patch content those closures carry. A patch reaches a workspace only when
// that workspace resolves the patched selector, so it is not a global input.
export const PATCH_DIR = 'patches/';

// Every path whose diff makes the detector parse a dependency with
// scripts/changed-dependencies.mjs, in the paths-filter glob syntax the ci.yml
// install gate lists.
export const DEPENDENCY_INPUTS = [...DEPENDENCY_MANIFESTS, `${PATCH_DIR}**`];

const isPatchFile = file => file.startsWith(PATCH_DIR);

export const isDependencyInput = file => DEPENDENCY_MANIFESTS.has(file) || isPatchFile(file);

const SOURCE_GLOBS = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'jsonc'];

const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/;

// Whether a relative reference to `target` reaches `file`. A reference names a
// path that may be a directory or omit the extension, so a file under the target
// or the same path with an extension counts.
const reaches = (target, file) =>
  file === target || file.startsWith(`${target}/`) || file.startsWith(`${target}.`);

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

export function selectAffected({ items, changedFiles, dependencyDirs, references }) {
  const dirs = items.map(item => item.dir);
  const dirOf = new Map(items.map(item => [item.name, item.dir]));
  const nameOf = new Map(items.map(item => [item.dir, item.name]));
  // Workspaces whose own test script runs their tests. The narrow below needs
  // it: without a test script no matrix row runs the workspace, so a reader's
  // runner may be the only one that does.
  const testScripted = new Set(
    items.filter(item => item.manifest?.scripts?.test).map(item => item.dir)
  );
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
  // [reader, workspace, test file, target]: the test file reads `target` in the
  // workspace as data.
  const testReads = [];
  for (const [file, target, asPath] of references) {
    const from = owner(dirs, file);
    const to = owner(dirs, target);
    const testFile = asPath && TEST_FILE.test(file) ? file : null;
    if (to && testFile) testReads.push([from, to, file, target]);
    else if (to) read(from, to);
    else if (from) rootReads.push([target, from, testFile]);
  }
  // One entry per reading test file and changed file: the test reads `changed`
  // through `target`, in `workspace`.
  const tested = [];

  // The workspaces that read a root path: a test that reads it as data runs the
  // reader's tests alone, and any other reader is a normal reader.
  const readRootPath = file => {
    const reading = rootReads.filter(
      ([target]) => file === target || file.startsWith(`${target}/`)
    );
    for (const [target, reader, testFile] of reading) {
      if (testFile) {
        tested.push({ reader, readerFile: testFile, target, workspace: null, changed: file });
      } else changed.add(reader);
    }
    return reading.length > 0;
  };

  const reasons = [];
  const fullChecks = new Set();
  const changed = new Set();
  // Workspaces whose own changed files are all test files. They join the
  // selection without their readers, unless something else adds them to
  // `changed`.
  const testOnlyChanged = new Set();
  for (const file of changedFiles) {
    const dir = owner(dirs, file);
    if (dir) {
      if (!file.endsWith('.md')) {
        if (TEST_FILE.test(file)) testOnlyChanged.add(dir);
        else changed.add(dir);
      }
      for (const [reader, workspace, testFile, target] of testReads) {
        if (file.startsWith(`${workspace}/`)) {
          tested.push({ reader, readerFile: testFile, target, workspace: dir, changed: file });
        }
      }
      for (const [pattern, reader] of EXTRA_INPUTS) {
        if (pattern.test(file) && readers.has(reader)) changed.add(reader);
      }
      continue;
    }
    // A table entry wins over a broad rule: it attributes a root path to one
    // workspace even when a GLOBAL pattern also covers it.
    const owned = OWNED.find(([pattern]) => pattern.test(file));
    if (!owned && GLOBAL.some(pattern => pattern.test(file))) {
      reasons.push(`${file} changes how every workspace is checked`);
      continue;
    }
    const input = CHECK_INPUTS.find(([pattern]) => pattern.test(file));
    if (input) {
      fullChecks.add(input[1]);
      continue;
    }
    if (isDependencyInput(file)) {
      // The closure names workspaces alone, so a test that reads the file as
      // data still needs its own workspace's tests.
      readRootPath(file);
      if (dependencyDirs.includes('*') || dependencyDirs.includes('.')) {
        reasons.push(`${file} changes root or unscoped dependencies`);
        continue;
      }
      const consumers = dependencyDirs.filter(dependencyDir => readers.has(dependencyDir));
      // A patch that no workspace resolves cannot be attributed: widen rather
      // than check no workspace at all.
      if (consumers.length === 0 && isPatchFile(file)) {
        reasons.push(`${file} changes a dependency patch that no workspace resolves`);
        continue;
      }
      for (const consumer of consumers) changed.add(consumer);
      continue;
    }
    const rootRead = readRootPath(file);
    if (owned) changed.add(owned[1]);
    if (owned || rootRead || isNeutral(file)) continue;
    reasons.push(`${file} is outside every workspace`);
  }

  const full = reasons.length > 0;
  // A test-only change that cannot narrow keeps the fan-out of a source change:
  // a workspace whose own test script does not run these files has no matrix row
  // of its own, so a reader may be their only runner.
  for (const dir of testOnlyChanged) {
    if (!testScripted.has(dir)) changed.add(dir);
  }
  // A workspace that `changed` also names keeps the fan-out: the mixed,
  // EXTRA_INPUTS and dependency cases.
  const narrowed = full ? [] : [...testOnlyChanged].filter(dir => !changed.has(dir));
  const affected = new Set(full ? dirs : []);
  const queue = full ? [] : [...changed];
  while (queue.length) {
    const dir = queue.pop();
    if (affected.has(dir)) continue;
    affected.add(dir);
    queue.push(...readers.get(dir));
  }
  // A narrowed workspace that the closure reached anyway already fans out: it
  // reads another changed workspace, so its readers see that change through it.
  for (const dir of narrowed) affected.add(dir);
  // Workspaces that only need their tests run, with the test files that read
  // changed data.
  const narrowedSet = new Set(narrowed);
  const testOnly = new Map();
  for (const { reader, readerFile, target, workspace, changed: file } of tested) {
    if (!reader || affected.has(reader)) continue;
    // A narrowed change touches only test files, so it leaves the data a reader
    // reads unchanged: the reader's tests run only when its reference reaches the
    // changed file itself.
    if (narrowedSet.has(workspace) && !reaches(target, file)) continue;
    testOnly.set(reader, (testOnly.get(reader) ?? new Set()).add(readerFile));
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

// Workspaces whose typecheck runs beside apps/web (scripts/web-env rides along
// with it).
const TYPECHECK_WEB_PACKAGES = ['web', '@kilocode/storybook'];

// Workspaces that another check owns: the web and trpc groups, kilo-app CI and
// extension CI. The packages group covers everything else.
const PACKAGES_GROUP_EXCLUDED = [
  'web',
  '@kilocode/trpc',
  '@kilocode/storybook',
  'kilo-app',
  'kilo-extension',
];

// Workspaces the rest lint group leaves out: kilo-app CI lints the app, and the
// extension belongs to the trpc group.
const LINT_REST_EXCLUDED_DIRS = ['apps/mobile', 'apps/extension'];

// The CI matrix groups that a selection pays for (the ci.yml `changes` job).
// The trpc rows repeat the extension's own typecheck and lint against the built
// tRPC declarations, and extension-ci.yml runs both for the same selection:
// `scripts/changed-workspaces.sh` reads this detector's `dirs`, so a pull
// request whose selection reaches the extension also runs its `verify` job. The
// rows therefore run only when the selection is a full check of that check.
// `scripts/typecheck-all.sh` then decides per event whether the typecheck row
// still needs the extension: a merge queue entry has no extension workflow to
// defer to, so the leg keeps the extension's gate there. A full lint also
// covers apps/mobile here, because kilo-app CI lints the app only when the app
// is affected.
export function selectGroups({ full_checks: fullChecks = [], dirs = [], packages = [] }) {
  const everyTypecheck = fullChecks.includes('typecheck');
  const everyLint = fullChecks.includes('lint');
  const typecheck_groups = [];
  if (everyTypecheck || TYPECHECK_WEB_PACKAGES.some(name => packages.includes(name))) {
    typecheck_groups.push('web');
  }
  if (everyTypecheck) typecheck_groups.push('trpc');
  if (everyTypecheck || packages.some(name => !PACKAGES_GROUP_EXCLUDED.includes(name))) {
    typecheck_groups.push('packages');
  }
  const lint_groups = [];
  if (everyLint) lint_groups.push('trpc');
  if (everyLint || dirs.some(dir => !LINT_REST_EXCLUDED_DIRS.includes(dir)))
    lint_groups.push('rest');
  return { typecheck_groups, lint_groups };
}

function detect(base, worktree) {
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
    ? git('diff', '--name-only', ...(worktree ? [base] : [base, 'HEAD']))
        .split('\n')
        .filter(Boolean)
    : ['<no base revision>'];
  const dependencyDirs = changedFiles.some(isDependencyInput)
    ? execFileSync('node', ['scripts/changed-dependencies.mjs', base], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    : [];
  const references = valid ? relativeReferences(items.map(item => item.dir)) : [];
  console.log(
    JSON.stringify({
      base,
      // A base the checkout cannot read selects every workspace instead of
      // attributing the change, so a consumer that compares this document with
      // another workflow's selection must not read that widening as an answer.
      base_valid: valid,
      ...selectAffected({ items, changedFiles, dependencyDirs, references }),
    })
  );
}

// Print the CI matrix groups for the selection JSON on standard input.
function printGroups() {
  console.log(JSON.stringify(selectGroups(JSON.parse(readFileSync(0, 'utf8')))));
}

if (import.meta.main) {
  if (process.argv[2] === '--groups') printGroups();
  else detect(process.argv[2] ?? '', process.argv.includes('--worktree'));
}
