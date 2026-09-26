#!/usr/bin/env node
/**
 * Read the production dependency closure of an app out of pnpm-lock.yaml.
 *
 * The JavaScript half of the per-artifact mobile SBOM. The minified bundle that
 * ships in the IPA/AAB carries no package metadata, so the lockfile closure
 * scoped to the app's production dependencies is the honest source. The
 * repo-wide SBOM (.github/workflows/sbom.yml) stays the whole-monorepo pnpm
 * tree; this reader returns only what the app ships.
 *
 * Usage:
 *   const { components, counts, skipped } =
 *     readPnpmProductionClosure({ lockfilePath: 'pnpm-lock.yaml' });
 *
 * `components` is one entry per resolved registry package (`link:`/`file:`
 * workspace packages recurse but are not registry packages), sorted by name
 * then version. An npm alias is reported under the real package it resolves to,
 * not the alias name. `skipped` lists dependency keys the lockfile declares
 * without a matching snapshots entry; the reader records them rather than
 * throwing.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { load } from 'js-yaml';

const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies'];
const SHA512_PREFIX = 'sha512-';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Importer entries carry `{ specifier, version }`; snapshot entries carry a
// bare version string. Accept both.
function dependencyVersion(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.version === 'string') return value.version;
  return undefined;
}

// The peer suffix pnpm appends to a resolved version (`0.86.3(patch_hash=…)…`)
// belongs to the snapshot key, not to the package version.
function stripPeerSuffix(version) {
  const index = version.indexOf('(');
  return index === -1 ? version : version.slice(0, index);
}

// An npm alias dependency (`"image-size": "npm:image-size-next@1.2.2"` in a
// manifest) resolves to a dependency value that already names the real
// package: `image-size: image-size-next@1.2.2`. That whole value is the
// snapshot key, and the component keeps the real package name rather than the
// alias. A plain version never contains '@'; a peer suffix does, so look only
// at the pre-suffix portion.
function aliasTarget(version) {
  const base = stripPeerSuffix(version);
  const separator = base.lastIndexOf('@');
  if (separator <= 0) return undefined;
  return { name: base.slice(0, separator), version: base.slice(separator + 1) };
}

// `link:../../packages/app-shared` from importer `apps/mobile` names the
// importer `packages/app-shared`, relative to the importing package.
// `file:packages/kilo-chat-hooks(@peer…)` names `packages/kilo-chat-hooks` from
// the workspace root, with the peer suffix stripped.
function workspaceImporterKey(version, baseDir) {
  const separator = version.indexOf(':');
  if (separator < 0) return undefined;
  const scheme = version.slice(0, separator);
  const target = stripPeerSuffix(version.slice(separator + 1));
  if (scheme === 'link') return posix.normalize(posix.join(baseDir, target));
  if (scheme === 'file') return posix.normalize(target);
  return undefined;
}

function toPurl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function integrityHashes(entry) {
  const integrity =
    isRecord(entry) && isRecord(entry.resolution) ? entry.resolution.integrity : undefined;
  if (typeof integrity !== 'string' || !integrity.startsWith(SHA512_PREFIX)) return undefined;
  const content = Buffer.from(integrity.slice(SHA512_PREFIX.length), 'base64').toString('hex');
  return [{ alg: 'SHA-512', content }];
}

function compareComponents(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

export function readPnpmProductionClosure({ lockfilePath, importer = 'apps/mobile' }) {
  const lockfile = load(readFileSync(lockfilePath, 'utf8'));
  const importers = isRecord(lockfile) && isRecord(lockfile.importers) ? lockfile.importers : {};
  if (!isRecord(importers[importer])) {
    throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
  }
  const packages = isRecord(lockfile.packages) ? lockfile.packages : {};
  const snapshots = isRecord(lockfile.snapshots) ? lockfile.snapshots : {};

  let direct = 0;
  for (const section of DEPENDENCY_SECTIONS) {
    if (isRecord(importers[importer][section]))
      direct += Object.keys(importers[importer][section]).length;
  }

  const componentsByPurl = new Map();
  const skippedKeys = new Set();
  const seenImporters = new Set();
  const seenSnapshots = new Set();
  const queue = [{ kind: 'importer', key: importer }];

  const enqueueDependency = (name, value, baseDir) => {
    const version = dependencyVersion(value);
    if (version === undefined) return;
    if (version.startsWith('link:') || version.startsWith('file:')) {
      const key = workspaceImporterKey(version, baseDir);
      if (key !== undefined && isRecord(importers[key])) {
        queue.push({ kind: 'importer', key });
      } else {
        skippedKeys.add(`${name}@${version}`);
      }
      return;
    }
    // An alias value names the real package, so the value itself is the
    // snapshot key and its name/version replace the alias entry.
    const alias = aliasTarget(version);
    const key = alias === undefined ? `${name}@${version}` : version;
    if (isRecord(snapshots[key])) {
      queue.push({
        kind: 'snapshot',
        key,
        name: alias === undefined ? name : alias.name,
        version: alias === undefined ? version : alias.version,
      });
    } else {
      // No snapshot entry. Record it instead of throwing so one gap cannot
      // empty the whole closure.
      skippedKeys.add(key);
    }
  };

  while (queue.length > 0) {
    const item = queue.pop();
    if (item.kind === 'importer') {
      if (seenImporters.has(item.key)) continue;
      seenImporters.add(item.key);
      const record = importers[item.key];
      if (!isRecord(record)) continue;
      for (const section of DEPENDENCY_SECTIONS) {
        if (!isRecord(record[section])) continue;
        for (const [name, value] of Object.entries(record[section])) {
          enqueueDependency(name, value, item.key);
        }
      }
      continue;
    }

    if (seenSnapshots.has(item.key)) continue;
    seenSnapshots.add(item.key);
    const snapshot = snapshots[item.key];
    if (!isRecord(snapshot)) {
      skippedKeys.add(item.key);
      continue;
    }

    const version = stripPeerSuffix(item.version);
    const purl = toPurl(item.name, version);
    if (!componentsByPurl.has(purl)) {
      const component = { ecosystem: 'npm', name: item.name, version, purl };
      // packages entries are keyed by the unsuffixed `name@version` in lockfile
      // v9; fall back to the snapshot key for a format that keeps the suffix.
      const hashes = integrityHashes(packages[`${item.name}@${version}`] ?? packages[item.key]);
      if (hashes !== undefined) component.hashes = hashes;
      componentsByPurl.set(purl, component);
    }

    for (const section of DEPENDENCY_SECTIONS) {
      if (!isRecord(snapshot[section])) continue;
      for (const [name, value] of Object.entries(snapshot[section])) {
        enqueueDependency(name, value, '');
      }
    }
  }

  const components = [...componentsByPurl.values()].sort(compareComponents);
  return {
    components,
    counts: { direct, resolved: components.length },
    skipped: [...skippedKeys].sort(),
  };
}
