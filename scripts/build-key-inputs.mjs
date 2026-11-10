// The lockfile contribution and the digest shared by the build cache keys
// (`harness-sdk-build-key.mjs`, `trpc-declaration-key.mjs`,
// `ttsc-plugin-key.mjs`).
//
// A key covers only the inputs that can change one build's output. Its
// dependency input is the lockfile entries that build resolves - the importer
// closure of the workspace, or the closure of the named packages that build it
// (its own entry plus every snapshot and package it resolves, and the patches
// inside that graph) - so a dependency change outside that graph leaves it
// alone. The dependency files themselves are left out of the per-file hash,
// because the closure pins them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  importerClosure,
  packageClosure,
  readDependencySnapshot,
} from './changed-dependencies.mjs';

// A stable serialisation: object keys are sorted, so a lockfile that only
// reorders entries keeps its digest.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(graph) {
  return canonical(
    [...graph].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
}

function widen(read, message, error) {
  console.error(`${message}; using the whole lockfile: ${error.message}`);
  return `lockfile\0${read('pnpm-lock.yaml')}`;
}

// The lockfile input of one build key. When the closure cannot be computed the
// whole lockfile stands in: a wider key costs a cache miss, a narrower one could
// restore an artifact built from other sources.
export function lockfileInput(root, directory) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  try {
    return `closure\0${digest(importerClosure(readDependencySnapshot(read), directory))}`;
  } catch (error) {
    return widen(read, `Cannot hash the ${directory} importer closure`, error);
  }
}

// The lockfile input of a build whose output depends on some of a workspace's
// dependencies rather than all of them: the closure of the named packages, so a
// sibling dependency in the same importer does not move the key.
export function packageClosureInput(root, directory, names) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  try {
    return `packages\0${digest(packageClosure(readDependencySnapshot(read), directory, names))}`;
  } catch (error) {
    return widen(read, `Cannot hash the ${directory} package closure`, error);
  }
}

// The digest of one build's inputs: the given repository files, then the
// lockfile input under its own label so the two halves cannot collide.
export function buildKeyInput(root, directory, files, packages) {
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(root, path)))
      .update('\0');
  }
  const input = packages
    ? packageClosureInput(root, directory, packages)
    : lockfileInput(root, directory);
  hash.update('pnpm-lock.yaml').update('\0').update(input).update('\0');
  return hash.digest('hex');
}
