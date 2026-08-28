import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { load } from 'js-yaml';

function withoutKeys(value, keys) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function dependencyGraph(lockfile, workspace, patches, directory) {
  const graph = new Map();
  const names = new Set();
  const nativeNames = new Set();

  function visitDependencies(dependencies, owner) {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      const version = typeof dependency === 'string' ? dependency : dependency.version;
      if (version.startsWith('link:')) {
        visitImporter(posix.join(owner, version.slice(5)));
        continue;
      }
      const id = Object.hasOwn(lockfile.snapshots, `${name}@${version}`)
        ? `${name}@${version}`
        : version;
      if (graph.has(id)) continue;
      const snapshot = lockfile.snapshots[id];
      const packageId = id.split('(')[0];
      const metadata = lockfile.packages[packageId];
      if (!snapshot || !metadata) throw new Error(`Missing lockfile entry: ${id}`);
      graph.set(id, { snapshot, metadata });
      const packageName = packageId.slice(0, packageId.indexOf('@', 1));
      names.add(packageName);
      if (Object.hasOwn(metadata.peerDependencies ?? {}, 'react-native'))
        nativeNames.add(packageName);
      visitDependencies(snapshot.dependencies, '.');
      visitDependencies(snapshot.optionalDependencies, '.');
    }
  }

  function visitImporter(directory) {
    const key = `importer:${directory}`;
    if (graph.has(key)) return;
    const importer = lockfile.importers[directory];
    if (!importer) throw new Error(`Missing lockfile importer: ${directory}`);
    graph.set(key, importer);
    visitDependencies(importer.dependencies, directory);
    visitDependencies(importer.devDependencies, directory);
    visitDependencies(importer.optionalDependencies, directory);
  }

  visitImporter(directory);
  const importer = lockfile.importers[directory];
  const usesNative = ['dependencies', 'devDependencies', 'optionalDependencies'].some(group =>
    Object.hasOwn(importer[group] ?? {}, 'react-native')
  );
  const ignoredHashes = [];
  for (const [selector, path] of Object.entries(workspace.patchedDependencies ?? {})) {
    const name = [...names].find(name => selector === name || selector.startsWith(`${name}@`));
    if (name) {
      if (!Object.hasOwn(patches, path)) throw new Error(`Missing dependency patch: ${path}`);
      const hash = lockfile.patchedDependencies?.[selector];
      if (
        !usesNative &&
        nativeNames.has(name) &&
        nativeOnlyPatch(patches[path]) &&
        typeof hash === 'string'
      ) {
        ignoredHashes.push(`(patch_hash=${hash})`);
      } else {
        graph.set(`patch:${selector}`, { path, content: patches[path], hash });
      }
    }
  }
  if (ignoredHashes.length === 0) return graph;
  let serialized = JSON.stringify([...graph]);
  for (const hash of ignoredHashes) serialized = serialized.replaceAll(hash, '');
  return new Map(JSON.parse(serialized));
}

function nativeOnlyPatch(content) {
  const lines = content.split('\n');
  const headers = lines.filter(line => line.startsWith('diff --git '));
  const targets = lines.filter(line => line.startsWith('--- ') || line.startsWith('+++ '));
  const isNative = path => /\.(native|ios|android)\.[cm]?[jt]sx?$/.test(path);
  return (
    headers.length > 0 &&
    targets.length >= 2 &&
    headers.every(header => {
      const paths = /^diff --git a\/(\S+) b\/(\S+)$/.exec(header);
      return paths && paths.slice(1).every(isNative);
    }) &&
    targets.every(header => {
      if (header === '--- /dev/null' || header === '+++ /dev/null') return true;
      const path = /^(?:--- a\/|\+\+\+ b\/)(\S+)$/.exec(header);
      return path && isNative(path[1]);
    })
  );
}

export function changedDependencyWorkspaces(before, after) {
  for (const { lockfile } of [before, after]) {
    if (lockfile.lockfileVersion !== '9.0' || !lockfile.importers || !lockfile.snapshots) {
      throw new Error('Unsupported pnpm lockfile');
    }
  }
  const lockfileSections = [
    'importers',
    'packages',
    'snapshots',
    'catalogs',
    'overrides',
    'packageExtensionsChecksum',
    'patchedDependencies',
  ];
  const workspaceSections = [
    'catalog',
    'catalogs',
    'overrides',
    'packageExtensions',
    'patchedDependencies',
  ];
  if (
    !isDeepStrictEqual(
      withoutKeys(before.lockfile, lockfileSections),
      withoutKeys(after.lockfile, lockfileSections)
    ) ||
    !isDeepStrictEqual(
      withoutKeys(before.workspace, workspaceSections),
      withoutKeys(after.workspace, workspaceSections)
    )
  ) {
    return ['*'];
  }

  const graph = (snapshot, directory) =>
    dependencyGraph(snapshot.lockfile, snapshot.workspace, snapshot.patches, directory);
  if (!isDeepStrictEqual(graph(before, '.'), graph(after, '.'))) return ['*'];

  const directories = new Set([
    ...Object.keys(before.lockfile.importers),
    ...Object.keys(after.lockfile.importers),
  ]);
  directories.delete('.');
  return [...directories].filter(directory => {
    if (!before.lockfile.importers[directory] || !after.lockfile.importers[directory]) return true;
    return !isDeepStrictEqual(graph(before, directory), graph(after, directory));
  });
}

function readSnapshot(read) {
  const workspace = load(read('pnpm-workspace.yaml'));
  const patches = {};
  for (const path of Object.values(workspace.patchedDependencies ?? {})) {
    if (typeof path !== 'string' || posix.isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error('Invalid dependency patch path');
    }
    patches[path] = read(path);
  }
  return { lockfile: load(read('pnpm-lock.yaml')), workspace, patches };
}

if (import.meta.main) {
  try {
    const base = process.argv[2];
    if (!base) throw new Error('A Git base revision is required');
    const before = readSnapshot(path =>
      execFileSync('git', ['show', `${base}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    const head = process.argv[3];
    const after = readSnapshot(path =>
      head
        ? execFileSync('git', ['show', `${head}:${path}`], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
          })
        : readFileSync(path, 'utf8')
    );
    console.log(changedDependencyWorkspaces(before, after).join('\n'));
  } catch (error) {
    console.error(`Cannot scope dependency changes; selecting all workspaces: ${error.message}`);
    console.log('*');
  }
}
