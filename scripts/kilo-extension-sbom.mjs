#!/usr/bin/env node
/**
 * Generate the CycloneDX 1.6 SBOM of one kilo-extension store zip.
 *
 * The source is the module record that the WXT build wrote with the
 * `KILO_EXTENSION_SBOM_MODULES_DIR` plugin (see
 * `apps/extension/scripts/sbom-modules-plugin.ts`): every module that rendered
 * bytes into an output chunk and every original file of an emitted asset. A
 * package is a component only when one of those files carries bytes of it, so a
 * package that Rolldown tree-shook out is not listed. Paths that do not exist on
 * disk, virtual module ids and first-party files outside node_modules are not
 * components: the first party is the document's own `metadata.component`.
 *
 * Usage:
 *   node scripts/kilo-extension-sbom.mjs --modules-dir <dir>
 *     --zip <file.zip> --browser <chrome|firefox> --version <semver>
 *     --lockfile <pnpm-lock.yaml> --commit <sha> --out <file.cyclonedx.json>
 *
 * The script prints `components=<n>` and `artifact_sha256=<hex>` on stdout.
 *
 * Exit codes:
 *   0 - the SBOM was written
 *   1 - an input is unreadable, or the zip carries no package
 *   2 - usage error
 */
/* eslint-disable anti-slop/no-runtime-typeof, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access -- The record files are parsed JSON: their shape is only known once it is decoded here, at the I/O boundary. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { load } from 'js-yaml';

import { sha256File, toCycloneDxComponents } from './mobile-sbom-cyclonedx.mjs';
import { compareComponents, integrityHashes, toPurl } from './mobile-sbom-pnpm.mjs';
import { packageRootOf } from './kilo-mcp-sbom.mjs';

const SPEC_VERSION = '1.6';
const APP_NAME = 'kilo-extension';
const BROWSERS = ['chrome', 'firefox'];
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const ARTIFACT_HASH_SOURCE = 'hash of the store zip built from this commit';
const MODULE_SOURCE =
  'Rolldown module graph of the WXT build: packages with rendered bytes in an output chunk or emitted as an asset';

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isByteCount = value => Number.isInteger(value) && value >= 0;

/** One decoded record file: module ids with their rendered bytes, assets with their bytes. */
function decodeRecord(file, parsed) {
  if (!isRecord(parsed) || !Array.isArray(parsed.modules) || !Array.isArray(parsed.assets)) {
    throw new Error(`${file}: not a module record with a modules and an assets array`);
  }
  const modules = parsed.modules.map(entry => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isByteCount(entry.bytes)) {
      throw new Error(`${file}: a module entry must be { id: string, bytes: integer }`);
    }
    return { id: entry.id, bytes: entry.bytes };
  });
  const assets = parsed.assets.map(entry => {
    if (!isRecord(entry) || typeof entry.file !== 'string' || !isByteCount(entry.bytes)) {
      throw new Error(`${file}: an asset entry must be { file: string, bytes: integer }`);
    }
    return { file: entry.file, bytes: entry.bytes };
  });
  return { modules, assets };
}

/** Every `*.json` record in `dir`, decoded. */
export function readModuleRecords(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot read --modules-dir ${dir}: ${error.message}`);
  }
  const files = names.filter(name => name.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`--modules-dir ${dir} holds no *.json module record`);
  }
  return files.map(name => {
    const path = join(dir, name);
    try {
      return decodeRecord(path, JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      throw new Error(`cannot read module record ${path}: ${error.message}`);
    }
  });
}

/**
 * The package a bundled file belongs to, or null for a file that is not part of
 * a package the zip ships: a virtual module, a path that no longer exists, or a
 * first-party file outside node_modules.
 */
function manifestOfBundledFile(file) {
  // Rolldown ids carry the query suffix of the importer that pulled them in.
  const query = file.indexOf('?');
  const path = query === -1 ? file : file.slice(0, query);
  if (path.startsWith('\0') || !existsSync(path)) {
    return null;
  }
  const root = packageRootOf(path);
  if (root === null) {
    return null;
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!isRecord(manifest) || typeof manifest.name !== 'string') {
    throw new Error(`${root}/package.json has no name`);
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`${root}/package.json has no version`);
  }
  return manifest;
}

/**
 * One npm component per package the build carries bytes of, sorted by name then
 * version, with the lockfile integrity as its hash when the lockfile has one.
 */
export function bundledComponents({ records, lockfile }) {
  const packages = isRecord(lockfile) && isRecord(lockfile.packages) ? lockfile.packages : {};
  const byPurl = new Map();
  const add = (file, bytes) => {
    if (!(bytes > 0)) {
      return;
    }
    const manifest = manifestOfBundledFile(file);
    if (manifest === null) {
      return;
    }
    const purl = toPurl(manifest.name, manifest.version);
    const known = byPurl.get(purl);
    if (known === undefined) {
      const hashes = integrityHashes(packages[`${manifest.name}@${manifest.version}`]);
      byPurl.set(purl, {
        ecosystem: 'npm',
        name: manifest.name,
        version: manifest.version,
        purl,
        ...(hashes === undefined ? {} : { hashes }),
        bytes,
      });
      return;
    }
    known.bytes += bytes;
  };

  for (const record of records) {
    for (const { id, bytes } of record.modules) {
      add(id, bytes);
    }
    for (const { file, bytes } of record.assets) {
      add(file, bytes);
    }
  }

  return [...byPurl.values()].sort(compareComponents).map(({ bytes, ...component }) => ({
    ...component,
    extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: String(bytes) }],
  }));
}

export function buildExtensionSbom({
  commit,
  version,
  browser,
  artifactName,
  artifactSha256,
  components,
}) {
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
        version,
        'bom-ref': `pkg:generic/${APP_NAME}@${version}`,
      },
      properties: [
        { name: 'kilo:sbom:commit', value: commit },
        { name: 'kilo:sbom:browser', value: browser },
        { name: 'kilo:sbom:artifact-name', value: artifactName },
        { name: 'kilo:sbom:artifact-sha256', value: artifactSha256 },
        { name: 'kilo:sbom:artifact-sha256-source', value: ARTIFACT_HASH_SOURCE },
        { name: 'kilo:sbom:source:npm', value: MODULE_SOURCE },
      ],
    },
    components: toCycloneDxComponents(components),
  };
}

function usage(message) {
  console.error(`kilo-extension-sbom: ${message}`);
  console.error(
    'Usage: node scripts/kilo-extension-sbom.mjs --modules-dir <dir> --zip <file> --browser <chrome|firefox> --version <semver> --lockfile <pnpm-lock.yaml> --commit <sha> --out <file>'
  );
  return 2;
}

function main() {
  const names = ['modules-dir', 'zip', 'browser', 'version', 'lockfile', 'commit', 'out'];
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
  if (!COMMIT_RE.test(options.commit)) {
    return usage(`--commit must be a full 40-character sha, got ${options.commit}`);
  }
  if (!BROWSERS.includes(options.browser)) {
    return usage(`--browser must be one of ${BROWSERS.join(', ')}, got ${options.browser}`);
  }
  if (!SEMVER_RE.test(options.version)) {
    return usage(`--version must be a semver version, got ${options.version}`);
  }

  try {
    const components = bundledComponents({
      records: readModuleRecords(resolve(options['modules-dir'])),
      lockfile: load(readFileSync(options.lockfile, 'utf8')),
    });
    if (components.length === 0) {
      console.error(
        'kilo-extension-sbom: the build carries no npm package; refusing an empty SBOM'
      );
      return 1;
    }
    const artifactSha256 = sha256File(options.zip);
    const doc = buildExtensionSbom({
      commit: options.commit,
      version: options.version,
      browser: options.browser,
      artifactName: basename(options.zip),
      artifactSha256,
      components,
    });
    writeFileSync(options.out, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`components=${components.length}`);
    console.log(`artifact_sha256=${artifactSha256}`);
    return 0;
  } catch (error) {
    console.error(`kilo-extension-sbom: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
