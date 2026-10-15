#!/usr/bin/env node
// Select the workspaces whose typecheck and lint results a change can alter.
//
// Usage: node scripts/affected-workspaces.mjs <base-sha>
// Prints JSON: { full, reasons, dirs, packages, build }.
//
// A workspace is affected when one of its files changed, or when it reads an
// affected workspace. A workspace reads another through a workspace:* entry in
// its package.json, or through a relative path (an import, a tsconfig `paths`
// or `include` entry, a config alias) that reaches into the other workspace. A
// workspace also reads every workspace nested inside it. A change that this
// script cannot attribute to a workspace selects everything (`full: true`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

// Packages that consumers typecheck and lint against as built output.
const BUILT_PACKAGES = ['@kilocode/trpc', '@kilocode/harness-sdk'];

// Root paths that change how every workspace is checked.
const GLOBAL = [
  /^(package\.json|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|\.nvmrc|\.oxlintrc\.json|\.oxfmtrc\.json|oxlint-plugin-drizzle\.js|tsconfig[^/]*\.json)$/,
  /^(patches|tools\/oxlint)\//,
  /^\.github\/workflows\/(ci|kilo-app-ci)\.yml$/,
  /^scripts\/(typecheck-all\.sh|lint-all\.sh|affected-workspaces\.mjs|changed-dependencies\.mjs)$/,
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

// [file, repository path] for every quoted relative path in workspace sources.
function relativeReferences(dirs) {
  let out = '';
  try {
    out = git(
      'grep',
      '-I',
      '-o',
      '-E',
      `['"](\\.\\./)+[^'"\`$ ]*['"]`,
      '--',
      ...dirs.flatMap(dir => SOURCE_GLOBS.map(ext => `${dir}/*.${ext}`))
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const references = [];
  for (const line of out.split('\n')) {
    const split = line.indexOf(':');
    if (split < 0) continue;
    const file = line.slice(0, split);
    const literal = line.slice(split + 2, -1).split('*')[0];
    const target = posix.normalize(posix.join(posix.dirname(file), literal)).replace(/\/$/, '');
    if (target.startsWith('..')) continue;
    references.push([file, target]);
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
  // Root paths (outside every workspace) that a workspace reads.
  const rootReads = [];
  for (const [file, target] of references) {
    const from = owner(dirs, file);
    const to = owner(dirs, target);
    if (to) read(from, to);
    else if (from) rootReads.push([target, from]);
  }

  const reasons = [];
  const changed = new Set();
  for (const file of changedFiles) {
    const dir = owner(dirs, file);
    if (dir) {
      if (!file.endsWith('.md')) changed.add(dir);
      for (const [pattern, reader] of EXTRA_INPUTS) {
        if (pattern.test(file) && readers.has(reader)) changed.add(reader);
      }
      continue;
    }
    if (GLOBAL.some(pattern => pattern.test(file))) {
      reasons.push(`${file} changes how every workspace is checked`);
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
    for (const [, reader] of rootReaders) changed.add(reader);
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
  const build = BUILT_PACKAGES.filter(name => {
    const dir = dirOf.get(name);
    if (!dir) return false;
    return affected.has(dir) || [...readers.get(dir)].some(reader => affected.has(reader));
  });
  return {
    full,
    reasons,
    dirs: [...affected].sort(),
    packages: [...affected].map(dir => nameOf.get(dir)).sort(),
    build,
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
