#!/usr/bin/env node
/**
 * Per-artifact mobile SBOM generator.
 *
 * One CycloneDX JSON document per shipped artifact, plus a summary linking each
 * document to the EAS build record it came from:
 *
 *   node scripts/mobile-sbom.mjs --ipa <app.ipa> --aab <app.aab> --build-json <build.json> --out-dir <dir> --podfile-lock <Podfile.lock>
 *
 * The inputs are the bytes that get submitted to the stores, so each document
 * is scoped to one artifact (never the repo-wide pnpm tree) and carries the
 * artifact's SHA-256, platform, version, build number and EAS build ID. The
 * Podfile.lock is the one EAS resolved for that iOS build (its build artifacts
 * archive): it lists the pods statically linked into the executable, which no
 * scan of the IPA can see.
 *
 * The EAS build record is read for identity only. Its `artifacts` URLs carry a
 * signed download token, so they are never read, printed or persisted.
 *
 * Every artifact/record/metadata failure throws before anything is written:
 * both documents are built in memory first, so a failure can never leave a
 * partial or one-sided output directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAabComponents } from './mobile-sbom-aab.mjs';
import {
  buildCycloneDxDocument,
  sbomFileName,
  sha256File,
  toCycloneDxComponents,
} from './mobile-sbom-cyclonedx.mjs';
import { readIpaComponents, readPodfileLockComponents } from './mobile-sbom-ipa.mjs';
import { readPnpmProductionClosure } from './mobile-sbom-pnpm.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PNPM_LOCKFILE_PATH = join(REPO_ROOT, 'pnpm-lock.yaml');
const SUMMARY_FILE_NAME = 'mobile-sbom-summary.json';
const USAGE =
  'Usage: node scripts/mobile-sbom.mjs --ipa <app.ipa> --aab <app.aab> --build-json <build.json> --out-dir <dir> --podfile-lock <Podfile.lock>';

// Source of each ecosystem, written into each document that carries it.
const ECOSYSTEM_ORDER = ['npm', 'cocoapods', 'maven', 'native-library'];
const ECOSYSTEM_SOURCES = {
  npm: 'pnpm-lock.yaml production dependency closure of apps/mobile (the minified shipped JS bundle carries no package metadata)',
  cocoapods:
    'Podfile.lock of the EAS build (one component per root pod in PODS:, subspecs collapsed, hash = SPEC CHECKSUMS podspec SHA-1) plus an IPA scan: Mach-O LC_LOAD_DYLIB/weak/reexport install names and Payload/*.app/Frameworks/ (OS-provided /usr/lib and /System/Library libraries excluded)',
  maven:
    'AAB BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb (Android Gradle Plugin resolved Maven artifacts)',
  'native-library': 'AAB base/lib/**/*.so',
};

const BUILD_PLATFORMS = { IOS: 'ios', ANDROID: 'android' };

class UsageError extends Error {}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requirePath(value, name) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty path`);
  }
  return value;
}

function parseBuildJson(buildJsonPath) {
  let raw;
  try {
    raw = readFileSync(buildJsonPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read build.json ${buildJsonPath}: ${error.message}`);
  }
  let builds;
  try {
    builds = JSON.parse(raw);
  } catch (error) {
    throw new Error(`build.json ${buildJsonPath} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(builds)) {
    throw new Error(`build.json ${buildJsonPath} must be a JSON array of EAS build records`);
  }
  return builds;
}

// Identity only. `artifacts` is deliberately never touched: its URLs are signed
// and carry a download token.
function requireRecordField(record, field, platform) {
  const value = record[field];
  if (isNonEmptyString(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error(`${platform} build record has no ${field}`);
}

function readBuildRecords(buildJsonPath) {
  const builds = parseBuildJson(buildJsonPath);
  const records = {};
  for (const [easPlatform, platform] of Object.entries(BUILD_PLATFORMS)) {
    const record = builds.find(build => build && build.platform === easPlatform);
    if (!record) {
      throw new Error(`build.json ${buildJsonPath} has no ${easPlatform} build record`);
    }
    if (record.status !== 'FINISHED') {
      throw new Error(
        `${easPlatform} build record status is ${JSON.stringify(record.status)}, expected "FINISHED"`
      );
    }
    records[platform] = {
      appVersion: requireRecordField(record, 'appVersion', easPlatform),
      appBuildVersion: requireRecordField(record, 'appBuildVersion', easPlatform),
      easBuildId: requireRecordField(record, 'id', easPlatform),
    };
  }
  return records;
}

function countEcosystems(components) {
  const counts = { npm: 0, cocoapods: 0, maven: 0, 'native-library': 0 };
  for (const component of components) {
    const property = component.properties.find(item => item.name === 'kilo:sbom:ecosystem');
    if (property && Object.hasOwn(counts, property.value)) {
      counts[property.value] += 1;
    }
  }
  return counts;
}

function buildPlatform({
  platform,
  artifactPath,
  appVersion,
  appBuildVersion,
  easBuildId,
  readerComponents,
}) {
  const artifactName = basename(artifactPath);
  const artifactSha256 = sha256File(artifactPath);
  const components = toCycloneDxComponents(readerComponents);
  const counts = countEcosystems(components);
  const sources = ECOSYSTEM_ORDER.filter(ecosystem => counts[ecosystem] > 0).map(ecosystem => ({
    ecosystem,
    source: ECOSYSTEM_SOURCES[ecosystem],
  }));
  const sbomFile = sbomFileName({ platform, appVersion, appBuildVersion });
  // Built whole: the caller writes only after every document has been assembled.
  const document = buildCycloneDxDocument({
    platform,
    appVersion,
    appBuildVersion,
    easBuildId,
    artifactName,
    artifactSha256,
    components,
    sources,
  });
  return {
    entry: {
      platform,
      artifactName,
      artifactSha256,
      appVersion,
      appBuildVersion,
      easBuildId,
      sbomFile,
      counts,
    },
    document,
  };
}

/**
 * Generate the ios and android SBOM documents and the summary for one build.
 * Returns `{ ios, android }`, each entry carrying its file name and counts.
 * Throws instead of writing anything if any input is missing or malformed.
 */
export function generateMobileSboms({
  ipaPath,
  aabPath,
  buildJsonPath,
  outDir,
  podfileLockPath,
} = {}) {
  requirePath(ipaPath, 'ipaPath');
  requirePath(aabPath, 'aabPath');
  requirePath(buildJsonPath, 'buildJsonPath');
  requirePath(outDir, 'outDir');
  requirePath(podfileLockPath, 'podfileLockPath');
  const records = readBuildRecords(buildJsonPath);

  const npmClosure = readPnpmProductionClosure({ lockfilePath: PNPM_LOCKFILE_PATH });
  const pods = readPodfileLockComponents({ podfileLockPath });
  const ipa = readIpaComponents({ ipaPath });
  const aab = readAabComponents({ aabPath });

  const ios = buildPlatform({
    platform: 'ios',
    artifactPath: ipaPath,
    ...records.ios,
    readerComponents: [...npmClosure.components, ...pods.components, ...ipa.components],
  });
  const android = buildPlatform({
    platform: 'android',
    artifactPath: aabPath,
    ...records.android,
    readerComponents: [...npmClosure.components, ...aab.components],
  });

  // Nothing has been written yet: a failure above this line leaves no file.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, ios.entry.sbomFile), `${JSON.stringify(ios.document, null, 2)}\n`);
  writeFileSync(
    join(outDir, android.entry.sbomFile),
    `${JSON.stringify(android.document, null, 2)}\n`
  );
  writeFileSync(
    join(outDir, SUMMARY_FILE_NAME),
    `${JSON.stringify({ ios: ios.entry, android: android.entry }, null, 2)}\n`
  );

  return { ios: ios.entry, android: android.entry };
}

function printReport(entries) {
  for (const entry of entries) {
    const ecosystems = ECOSYSTEM_ORDER.filter(ecosystem => entry.counts[ecosystem] > 0)
      .map(ecosystem => `${ecosystem}=${entry.counts[ecosystem]}`)
      .join(' ');
    console.log(
      `${entry.platform}: ${entry.artifactName} sha256=${entry.artifactSha256} sbom=${entry.sbomFile} ${ecosystems}`
    );
  }
}

function parseArgs(argv) {
  const flags = {
    '--ipa': 'ipaPath',
    '--aab': 'aabPath',
    '--build-json': 'buildJsonPath',
    '--out-dir': 'outDir',
    '--podfile-lock': 'podfileLockPath',
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags[flag];
    if (!key) {
      throw new UsageError(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  for (const flag of ['--ipa', '--aab', '--build-json', '--out-dir', '--podfile-lock']) {
    if (!options[flags[flag]]) {
      throw new UsageError(`${flag} is required`);
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const { ios, android } = generateMobileSboms(options);
    printReport([ios, android]);
  } catch (error) {
    console.error(`mobile-sbom: ${error.message}`);
    if (error instanceof UsageError) {
      console.error(USAGE);
    }
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
