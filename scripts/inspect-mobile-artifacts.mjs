#!/usr/bin/env node
/**
 * Inspect signed kilo-app mobile artifacts before submission.
 *
 * Usage:
 *   node scripts/inspect-mobile-artifacts.mjs <ipa> <aab> <build.json>
 *   node scripts/inspect-mobile-artifacts.mjs --select <build.json>
 *
 * The full mode unzips the IPA, parses its Info.plist, dumps the AAB manifest
 * with bundletool, and checks debug symbols. The --select mode validates the
 * EAS build.json (every build FINISHED, one IOS and one ANDROID entry with an
 * applicationArchiveUrl) and prints the two archive URLs, one per line.
 *
 * Exits 1 with a clear message on any contract violation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp';
const ANDROID_PACKAGE = 'com.kilocode.kiloapp';
const SKADNETWORK_ENDPOINT = 'https://appsflyer-skadnetwork.com/';
const INTENT_FILTER_HOST = 'app.kilo.ai';
const BUNDLETOOL_URL =
  'https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar';
const DEBUGSYMBOLS_PREFIX = 'BUNDLE-METADATA/com.android.tools.build.debugsymbols/';
const SHRINK_SENTINEL = 'kilo_shrink_sentinel_unused';
const REQUIRED_USAGE_DESCRIPTIONS = [
  'NSMicrophoneUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSUserTrackingUsageDescription',
];
const BLOCKED_PERMISSIONS = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
];

const failures = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function reportAndExit() {
  if (failures.length === 0) {
    process.exit(0);
  }
  console.error('Mobile artifact inspection failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

function parseBuildJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    failures.push(`cannot read build.json: ${error.message}`);
    reportAndExit();
  }
  let builds;
  try {
    builds = JSON.parse(raw);
  } catch (error) {
    failures.push(`build.json is not valid JSON: ${error.message}`);
    reportAndExit();
  }
  if (!Array.isArray(builds)) {
    failures.push('build.json must be a JSON array of build objects');
    reportAndExit();
  }
  return builds;
}

function assertAllFinished(builds) {
  const unfinished = builds.filter(build => build && build.status !== 'FINISHED');
  if (unfinished.length > 0) {
    const detail = unfinished
      .map(build => `${build.platform ?? 'unknown'}=${build.status ?? 'missing'}`)
      .join(', ');
    failures.push(`every EAS build must be FINISHED, got: ${detail}`);
  }
}

function selectBuild(builds, platform) {
  return builds.find(build => build && build.platform === platform);
}

function artifactUrl(build) {
  return build?.artifacts?.applicationArchiveUrl ?? '';
}

function selectMode(buildJsonPath) {
  const builds = parseBuildJson(buildJsonPath);
  assertAllFinished(builds);
  const ios = selectBuild(builds, 'IOS');
  const android = selectBuild(builds, 'ANDROID');
  if (!ios) {
    failures.push('build.json has no IOS build');
  }
  if (!android) {
    failures.push('build.json has no ANDROID build');
  }
  const iosUrl = artifactUrl(ios);
  const androidUrl = artifactUrl(android);
  if (!iosUrl) {
    failures.push('IOS build has no artifacts.applicationArchiveUrl');
  }
  if (!androidUrl) {
    failures.push('ANDROID build has no artifacts.applicationArchiveUrl');
  }
  if (failures.length > 0) {
    reportAndExit();
  }
  process.stdout.write(`${iosUrl}\n${androidUrl}\n`);
  process.exit(0);
}

function parseInfoPlist(plistPath) {
  // A signed IPA's Info.plist is binary. Python's plistlib stdlib handles both
  // XML and binary formats and is preinstalled on the ubuntu-latest runner.
  const script = [
    'import plistlib, json, sys',
    'with open(sys.argv[1], "rb") as f:',
    '    data = plistlib.load(f)',
    'json.dump(data, sys.stdout)',
  ].join('\n');
  const out = run('python3', ['-c', script, plistPath]);
  return JSON.parse(out);
}

function inspectIos(ipaPath) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-inspect-ios-'));
  try {
    const extractDir = join(work, 'ipa');
    mkdirSync(extractDir, { recursive: true });
    try {
      run('unzip', ['-q', '-o', ipaPath, '-d', extractDir]);
    } catch (error) {
      failures.push(`cannot unzip IPA ${ipaPath}: ${error.message}`);
      return;
    }

    const payloadDir = join(extractDir, 'Payload');
    let appName;
    try {
      appName = readdirSync(payloadDir).find(entry => entry.endsWith('.app'));
    } catch {
      appName = undefined;
    }
    if (!appName) {
      failures.push(`IPA has no Payload/*.app bundle (checked ${payloadDir})`);
      return;
    }
    const appPath = join(payloadDir, appName);

    let plist;
    try {
      plist = parseInfoPlist(join(appPath, 'Info.plist'));
    } catch (error) {
      failures.push(`cannot parse Info.plist: ${error.message}`);
      return;
    }

    check(
      plist.CFBundleIdentifier === BUNDLE_IDENTIFIER,
      `CFBundleIdentifier must be "${BUNDLE_IDENTIFIER}", got "${plist.CFBundleIdentifier}"`
    );
    check(
      existsSync(join(appPath, 'PrivacyInfo.xcprivacy')),
      'PrivacyInfo.xcprivacy must exist in the .app bundle'
    );
    for (const key of REQUIRED_USAGE_DESCRIPTIONS) {
      check(
        typeof plist[key] === 'string' && plist[key].length > 0,
        `Info.plist must contain a non-empty ${key}`
      );
    }
    check(
      plist.NSAdvertisingAttributionReportEndpoint === SKADNETWORK_ENDPOINT,
      `NSAdvertisingAttributionReportEndpoint must be "${SKADNETWORK_ENDPOINT}"`
    );
    check(
      plist.AttributionCopyEndpoint === SKADNETWORK_ENDPOINT,
      `AttributionCopyEndpoint must be "${SKADNETWORK_ENDPOINT}"`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function listZipEntries(zipPath) {
  try {
    return run('unzip', ['-Z1', zipPath])
      .split('\n')
      .filter(entry => entry.length > 0);
  } catch (error) {
    failures.push(`cannot list zip entries of ${zipPath}: ${error.message}`);
    return [];
  }
}

function inspectAndroid(aabPath) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-inspect-android-'));
  try {
    const jarPath = join(work, 'bundletool.jar');
    try {
      run('curl', ['-fsSL', BUNDLETOOL_URL, '-o', jarPath]);
    } catch (error) {
      failures.push(`cannot download bundletool: ${error.message}`);
      return;
    }

    let manifest;
    try {
      manifest = run('java', ['-jar', jarPath, 'dump', 'manifest', '--bundle', aabPath]);
    } catch (error) {
      failures.push(`bundletool dump manifest failed: ${error.message}`);
      return;
    }

    const packageMatch = manifest.match(/package="([^"]+)"/);
    check(
      packageMatch?.[1] === ANDROID_PACKAGE,
      `android package must be "${ANDROID_PACKAGE}", got "${packageMatch?.[1] ?? 'none'}"`
    );
    for (const permission of BLOCKED_PERMISSIONS) {
      check(
        !manifest.includes(`android:name="${permission}"`),
        `${permission} must be absent from the manifest`
      );
    }
    check(
      !manifest.includes('usesCleartextTraffic="true"'),
      'usesCleartextTraffic="true" must be absent from the manifest'
    );
    check(
      manifest.includes(`android:host="${INTENT_FILTER_HOST}"`),
      `intent-filter host must be "${INTENT_FILTER_HOST}"`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function checkSymbols(aabPath) {
  const entries = listZipEntries(aabPath);
  const aabHasDebugSymbols = entries.some(entry => entry.startsWith(DEBUGSYMBOLS_PREFIX));
  check(aabHasDebugSymbols, `no debug symbols: the AAB has no ${DEBUGSYMBOLS_PREFIX} entries`);
}

/**
 * Returns true when the AAB zip has no kilo_shrink_sentinel_unused entry
 * (resource shrinking stripped the unused raw resource) and false when it does.
 * Kept side-effect free so tests can import it without touching `failures`.
 */
export function checkResourceShrinking(aabPath) {
  const entries = listZipEntries(aabPath);
  const sentinelPresent = entries.some(entry => entry.includes(SHRINK_SENTINEL));
  return !sentinelPresent;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--select') {
    if (args.length !== 2) {
      console.error('Usage: node inspect-mobile-artifacts.mjs --select <build.json>');
      process.exit(2);
    }
    selectMode(args[1]);
    return;
  }
  if (args.length !== 3) {
    console.error('Usage: node inspect-mobile-artifacts.mjs <ipa> <aab> <build.json>');
    console.error('       node inspect-mobile-artifacts.mjs --select <build.json>');
    process.exit(2);
  }
  const [ipaPath, aabPath, buildJsonPath] = args;
  const builds = parseBuildJson(buildJsonPath);
  assertAllFinished(builds);
  inspectIos(ipaPath);
  inspectAndroid(aabPath);
  checkSymbols(aabPath);
  check(checkResourceShrinking(aabPath), 'unused shrink sentinel still in the AAB');
  reportAndExit();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
