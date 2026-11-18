#!/usr/bin/env node
/**
 * Generate the CycloneDX SBOM of one kilo-mcp production bundle.
 *
 * The source is the esbuild metafile that `wrangler deploy --dry-run
 * --metafile` writes beside the bundle. A package is a component only when the
 * bundle carries bytes of it, so a package that esbuild tree-shook out is not
 * listed. Inputs that do not exist on disk (wrangler's virtual polyfill
 * modules) and first-party inputs outside node_modules are not components: the
 * first party is the document's own `metadata.component`.
 *
 * Usage:
 *   node scripts/kilo-mcp-sbom.mjs --metafile <meta.json> --bundle <index.js>
 *     --worker-dir <dir> --lockfile <pnpm-lock.yaml> --commit <sha>
 *     --release <tag> --out <file.cyclonedx.json>
 *
 * `--worker-dir` is the directory wrangler ran in: the metafile paths are
 * relative to it. The script prints `components=<n>` and
 * `artifact_sha256=<hex>` on stdout.
 *
 * Exit codes:
 *   0 - the SBOM was written
 *   1 - an input is unreadable, or the bundle carries no package
 *   2 - usage error
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { load } from 'js-yaml';

import { sha256File, toCycloneDxComponents } from './mobile-sbom-cyclonedx.mjs';
import { compareComponents, integrityHashes, toPurl } from './mobile-sbom-pnpm.mjs';

const SPEC_VERSION = '1.6';
const APP_NAME = 'kilo-mcp';
const NODE_MODULES = '/node_modules/';
const ARTIFACT_HASH_SOURCE =
  'hash of the wrangler bundle built from the deployed commit with the locked wrangler';
const METAFILE_SOURCE = 'esbuild metafile of the wrangler bundle, inputs with bytes in the output';

/**
 * The package root of a bundled file: the directory right below its last
 * `node_modules/`, two levels deep for a scoped package. Null for a file
 * outside node_modules.
 */
export function packageRootOf(absolutePath) {
  const index = absolutePath.lastIndexOf(NODE_MODULES);
  if (index < 0) {
    return null;
  }
  const rest = absolutePath.slice(index + NODE_MODULES.length).split('/');
  const depth = rest[0].startsWith('@') ? 2 : 1;
  if (rest.length <= depth) {
    return null;
  }
  return absolutePath.slice(0, index + NODE_MODULES.length) + rest.slice(0, depth).join('/');
}

/** The output entry of the bundle file in an esbuild metafile. */
function bundleOutput(metafile, workerDir, bundlePath) {
  const target = resolve(bundlePath);
  for (const [path, output] of Object.entries(metafile.outputs ?? {})) {
    if (resolve(workerDir, path) === target) {
      return output;
    }
  }
  throw new Error(`the metafile has no output for ${bundlePath}`);
}

/**
 * One npm component per package the bundle carries bytes of, sorted by name
 * then version, with the lockfile integrity as its hash when the lockfile has
 * one.
 */
export function bundledPackages({ metafile, workerDir, bundlePath, lockfile }) {
  const output = bundleOutput(metafile, workerDir, bundlePath);
  const packages = lockfile && typeof lockfile.packages === 'object' ? lockfile.packages : {};
  const byPurl = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
    const absolute = resolve(workerDir, input);
    if (!(bytesInOutput > 0) || !existsSync(absolute)) {
      continue;
    }
    const root = packageRootOf(absolute);
    if (root === null) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const purl = toPurl(manifest.name, manifest.version);
    const known = byPurl.get(purl);
    if (known) {
      known.bytes += bytesInOutput;
      continue;
    }
    const hashes = integrityHashes(packages[`${manifest.name}@${manifest.version}`]);
    byPurl.set(purl, {
      ecosystem: 'npm',
      name: manifest.name,
      version: manifest.version,
      purl,
      ...(hashes ? { hashes } : {}),
      bytes: bytesInOutput,
    });
  }
  return [...byPurl.values()].sort(compareComponents).map(({ bytes, ...component }) => ({
    ...component,
    extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: String(bytes) }],
  }));
}

export function buildWorkerSbom({ commit, release, artifactName, artifactSha256, components }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: APP_NAME,
        version: commit,
        'bom-ref': `pkg:generic/${APP_NAME}@${commit}`,
      },
      properties: [
        { name: 'kilo:sbom:commit', value: commit },
        { name: 'kilo:sbom:release-tag', value: release },
        { name: 'kilo:sbom:artifact-name', value: artifactName },
        { name: 'kilo:sbom:artifact-sha256', value: artifactSha256 },
        { name: 'kilo:sbom:artifact-sha256-source', value: ARTIFACT_HASH_SOURCE },
        { name: 'kilo:sbom:source:npm', value: METAFILE_SOURCE },
      ],
    },
    components: toCycloneDxComponents(components),
  };
}

function usage(message) {
  console.error(`kilo-mcp-sbom: ${message}`);
  console.error(
    'Usage: node scripts/kilo-mcp-sbom.mjs --metafile <meta.json> --bundle <index.js> --worker-dir <dir> --lockfile <pnpm-lock.yaml> --commit <sha> --release <tag> --out <file>'
  );
  return 2;
}

function main() {
  const names = ['metafile', 'bundle', 'worker-dir', 'lockfile', 'commit', 'release', 'out'];
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !names.includes(name) || args[index + 1] === undefined) {
      return usage(`bad argument: ${args[index]}`);
    }
    options[name] = args[index + 1];
  }
  const missing = names.filter(name => !options[name]);
  if (missing.length > 0) {
    return usage(`missing --${missing.join(', --')}`);
  }
  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    return usage(`--commit must be a full 40-character sha, got ${options.commit}`);
  }

  try {
    const components = bundledPackages({
      metafile: JSON.parse(readFileSync(options.metafile, 'utf8')),
      workerDir: resolve(options['worker-dir']),
      bundlePath: options.bundle,
      lockfile: load(readFileSync(options.lockfile, 'utf8')),
    });
    if (components.length === 0) {
      console.error('kilo-mcp-sbom: the bundle carries no npm package; refusing an empty SBOM');
      return 1;
    }
    const artifactSha256 = sha256File(options.bundle);
    const doc = buildWorkerSbom({
      commit: options.commit,
      release: options.release,
      artifactName: basename(options.bundle),
      artifactSha256,
      components,
    });
    writeFileSync(options.out, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`components=${components.length}`);
    console.log(`artifact_sha256=${artifactSha256}`);
    return 0;
  } catch (error) {
    console.error(`kilo-mcp-sbom: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
