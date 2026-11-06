// The lockfile contribution and the digest shared by the build cache keys
// (`harness-sdk-build-key.mjs`, `trpc-declaration-key.mjs`).
//
// A key covers only the inputs that can change one build's output. Its
// dependency input is the lockfile entries of that workspace's importer closure
// (its own entry plus every snapshot and package it resolves, and the patches
// inside that graph), so a dependency change in another workspace leaves it
// alone. The dependency files themselves are left out of the per-file hash,
// because the closure pins them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { importerClosure, readDependencySnapshot } from './changed-dependencies.mjs';

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

function closureDigest(snapshot, directory) {
  const entries = [...importerClosure(snapshot, directory)].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return canonical(entries);
}

// The lockfile input of one build key. When the closure cannot be computed the
// whole lockfile stands in: a wider key costs a cache miss, a narrower one could
// restore an artifact built from other sources.
export function lockfileInput(root, directory) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  try {
    return `closure\0${closureDigest(readDependencySnapshot(read), directory)}`;
  } catch (error) {
    console.error(
      `Cannot hash the ${directory} importer closure; using the whole lockfile: ${error.message}`
    );
    return `lockfile\0${read('pnpm-lock.yaml')}`;
  }
}

// The digest of one build's inputs: the given repository files, then the
// lockfile input under its own label so the two halves cannot collide.
export function buildKeyInput(root, directory, files) {
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(root, path)))
      .update('\0');
  }
  hash.update('pnpm-lock.yaml').update('\0').update(lockfileInput(root, directory)).update('\0');
  return hash.digest('hex');
}
