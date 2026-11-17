#!/usr/bin/env node
/**
 * Turn a CycloneDX SBOM into a GitHub dependency submission snapshot.
 *
 * GitHub's dependency graph only reads committed manifests and lockfiles. What
 * a build resolves on its own (global `npm install -g` and lockfile-less
 * installs in a Dockerfile, Go binaries, the Maven libraries Gradle bundles
 * into an Android App Bundle) never reaches it, so Dependabot never alerts on
 * it. Submitting the SBOM of the shipped artifact closes that gap.
 *
 * Every component lands under one manifest, so an advisory raises one alert
 * per vulnerable version instead of one per install location. Only purl types
 * the GitHub Advisory Database covers are kept: an OS package or a generic
 * binary can never match an advisory and would only pad the graph.
 *
 * Usage:
 *   node scripts/dependency-snapshot.mjs --sbom <file.cyclonedx.json>
 *     --manifest <name> [--source <repo path>] --correlator <id>
 *     [--types npm,maven,...] > snapshot.json
 *
 * The commit, ref and run come from GITHUB_SHA, GITHUB_REF and GITHUB_RUN_ID.
 *
 * Exit codes:
 *   0 - the snapshot was written to stdout
 *   1 - the SBOM is unreadable or holds no submittable component
 *   2 - usage error
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// purl types with advisories in the GitHub Advisory Database.
export const ADVISORY_TYPES = [
  'cargo',
  'composer',
  'gem',
  'golang',
  'hex',
  'maven',
  'npm',
  'nuget',
  'pub',
  'pypi',
  'swift',
];

const DETECTOR = {
  name: 'kilo-cyclonedx-snapshot',
  version: '1.0.0',
  url: 'https://github.com/Kilo-Org/cloud/blob/main/scripts/dependency-snapshot.mjs',
};

class UsageError extends Error {}

function purlType(purl) {
  const match = /^pkg:([a-z0-9.+-]+)\//i.exec(purl);
  return match ? match[1].toLowerCase() : null;
}

// A purl without a version cannot be matched against an advisory range.
function hasVersion(purl) {
  const path = purl.split(/[?#]/)[0];
  return path.lastIndexOf('@') > path.lastIndexOf('/') && !path.endsWith('@');
}

function* walkComponents(components) {
  for (const component of components ?? []) {
    yield component;
    yield* walkComponents(component.components);
  }
}

/** Unique, sorted purls of the SBOM components whose type is in `types`. */
export function submittablePurls(bom, types = ADVISORY_TYPES) {
  const allowed = new Set(types);
  const purls = new Set();
  for (const component of walkComponents(bom?.components)) {
    const purl = component?.purl;
    if (typeof purl !== 'string' || !allowed.has(purlType(purl)) || !hasVersion(purl)) {
      continue;
    }
    purls.add(purl);
  }
  return [...purls].sort();
}

export function buildSnapshot({
  purls,
  manifest,
  source,
  sha,
  ref,
  correlator,
  runId,
  runUrl,
  scanned,
}) {
  if (purls.length === 0) {
    // An empty snapshot replaces the previous one and closes every alert it
    // raised, so a scan that found nothing must fail instead.
    throw new Error('buildSnapshot: no submittable component');
  }
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`buildSnapshot: sha must be a full commit SHA, got ${JSON.stringify(sha)}`);
  }
  if (!(ref ?? '').startsWith('refs/')) {
    throw new Error(`buildSnapshot: ref must be a full Git ref, got ${JSON.stringify(ref)}`);
  }
  const resolved = Object.fromEntries(
    purls.map(purl => [purl, { package_url: purl, scope: 'runtime' }])
  );
  return {
    version: 0,
    sha,
    ref,
    job: { correlator, id: runId, ...(runUrl ? { html_url: runUrl } : {}) },
    detector: DETECTOR,
    scanned,
    manifests: {
      [manifest]: {
        name: manifest,
        ...(source ? { file: { source_location: source } } : {}),
        resolved,
      },
    },
  };
}

function summarize(purls) {
  const counts = new Map();
  for (const purl of purls) {
    const type = purlType(purl);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}=${count}`)
    .join(' ');
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sbom: { type: 'string' },
      manifest: { type: 'string' },
      source: { type: 'string' },
      correlator: { type: 'string' },
      types: { type: 'string' },
    },
  });
  for (const name of ['sbom', 'manifest', 'correlator']) {
    if (!values[name]) {
      throw new UsageError(`--${name} is required`);
    }
  }
  const types = values.types ? values.types.split(',').map(type => type.trim()) : ADVISORY_TYPES;
  const unknown = types.filter(type => !ADVISORY_TYPES.includes(type));
  if (unknown.length > 0) {
    throw new UsageError(`--types has no advisories for: ${unknown.join(', ')}`);
  }
  return { ...values, types };
}

function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`dependency-snapshot: ${error.message}`);
    console.error(
      'Usage: node scripts/dependency-snapshot.mjs --sbom <file> --manifest <name> [--source <path>] --correlator <id> [--types npm,maven,...]'
    );
    process.exit(2);
  }
  const env = process.env;
  try {
    const bom = JSON.parse(readFileSync(options.sbom, 'utf8'));
    const purls = submittablePurls(bom, options.types);
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    const snapshot = buildSnapshot({
      purls,
      manifest: options.manifest,
      source: options.source,
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      correlator: options.correlator,
      runId: env.GITHUB_RUN_ID ?? 'local',
      runUrl,
      scanned: new Date().toISOString(),
    });
    console.error(`dependency-snapshot: ${purls.length} packages (${summarize(purls)})`);
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    console.error(`dependency-snapshot: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
