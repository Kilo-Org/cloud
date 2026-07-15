import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SOURCE_SKIPS, SourceSkips } from '@expo/fingerprint';

const PACKAGE_ID = 'com.kilocode.kiloapp';
const BUILD_MODE = 'debug-dev-client';

export type AndroidCompatibility = {
  nativeHash: string;
  gradleVersion: string;
  javaVersion: string;
  androidSdkIdentity: string;
  hostArch: string;
  buildMode: 'debug-dev-client';
};

type AndroidManifest = AndroidCompatibility & {
  key: string;
  packageId: string;
  artifactChecksum: string;
  producerWorktree: string;
  createdAt: string;
};

export type AndroidBuildDeps = {
  cacheRoot: string;
  claimRoot: string;
  worktreeRoot: string;
  mobileRoot: string;
  fingerprint: (
    mobileRoot: string,
    options: ReturnType<typeof buildAndroidFingerprintOptions>
  ) => Promise<string>;
  compatibility: () => Omit<AndroidCompatibility, 'nativeHash' | 'buildMode'>;
  withNativeBuildSlot: <T>(run: () => Promise<T>) => Promise<T>;
  build: (stagingDir: string) => Promise<string>;
  readPackageId: (apkPath: string) => string | undefined;
  install: (serial: string, apkPath: string) => void;
  now: () => Date;
};

export function buildAndroidFingerprintOptions(): {
  platforms: ['android'];
  sourceSkips: number;
  silent: boolean;
} {
  return {
    platforms: ['android'],
    sourceSkips: DEFAULT_SOURCE_SKIPS | SourceSkips.ExpoConfigExtraSection,
    silent: true,
  };
}

export function buildAndroidCompatibilityKey(value: AndroidCompatibility): string {
  const normalized = {
    androidSdkIdentity: value.androidSdkIdentity,
    buildMode: value.buildMode,
    gradleVersion: value.gradleVersion,
    hostArch: value.hostArch,
    javaVersion: value.javaVersion,
    nativeHash: value.nativeHash,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function validateAndroidBuildClaim(
  serial: string,
  worktreeRoot: string,
  claimRoot: string
): void {
  const claimPath = path.join(claimRoot, `${serial.replaceAll('/', '_')}.json`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw new Error(`${serial} is not claimed by this worktree`);
    throw new Error(`${serial} claim is corrupt`, { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${serial} claim is corrupt`);
  const claim = value as Record<string, unknown>;
  if (typeof claim.worktreeRoot !== 'string') throw new Error(`${serial} claim is corrupt`);
  if (claim.worktreeRoot !== worktreeRoot)
    throw new Error(`${serial} is claimed by ${claim.worktreeRoot}`);
  if (claim.status !== 'ready') throw new Error(`${serial} claim is not ready`);
  if (typeof claim.claimId !== 'string' || claim.claimId.length === 0) {
    throw new Error(`${serial} claim is corrupt`);
  }
  if (
    typeof claim.claimedAt !== 'string' ||
    Number.isNaN(Date.parse(claim.claimedAt)) ||
    new Date(claim.claimedAt).toISOString() !== claim.claimedAt
  ) {
    throw new Error(`${serial} claim is corrupt`);
  }
}

export function buildAndroidInstallCommand(
  adb: string,
  serial: string,
  apkPath: string
): { command: string; args: string[] } {
  return { command: adb, args: ['-s', serial, 'install', '-r', apkPath] };
}

export async function runAndroidBuild(serial: string, deps: AndroidBuildDeps): Promise<void> {
  validateAndroidBuildClaim(serial, deps.worktreeRoot, deps.claimRoot);
  const nativeHash = await deps.fingerprint(deps.mobileRoot, buildAndroidFingerprintOptions());
  const compatibility: AndroidCompatibility = {
    ...deps.compatibility(),
    nativeHash,
    buildMode: BUILD_MODE,
  };
  const key = buildAndroidCompatibilityKey(compatibility);
  let entry = await lookup(deps.cacheRoot, key, compatibility, deps.readPackageId);
  if (!entry) {
    entry = await deps.withNativeBuildSlot(async () => {
      const queuedHit = await lookup(deps.cacheRoot, key, compatibility, deps.readPackageId);
      if (queuedHit) return queuedHit;
      return publish(serial, key, compatibility, deps);
    });
  }
  deps.install(serial, entry.apkPath);
}

async function lookup(
  cacheRoot: string,
  key: string,
  compatibility: AndroidCompatibility,
  readPackageId: (apkPath: string) => string | undefined
): Promise<{ apkPath: string; manifest: AndroidManifest } | undefined> {
  const entry = path.join(cacheRoot, 'entries', key);
  const apkPath = path.join(entry, 'Kilo.apk');
  const manifestPath = path.join(entry, 'manifest.json');
  if (!fs.existsSync(apkPath) || !fs.existsSync(manifestPath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isManifest(value, key, compatibility)) return undefined;
  if ((await hashFile(apkPath)) !== value.artifactChecksum) return undefined;
  if (readPackageId(apkPath) !== PACKAGE_ID) return undefined;
  return { apkPath, manifest: value };
}

async function publish(
  serial: string,
  key: string,
  compatibility: AndroidCompatibility,
  deps: AndroidBuildDeps
): Promise<{ apkPath: string; manifest: AndroidManifest }> {
  const stagingRoot = path.join(deps.cacheRoot, 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stagingRoot, `${key}-`));
  try {
    const producedApk = await deps.build(staging);
    if (!isWithinRealPath(producedApk, staging) || !fs.statSync(producedApk).isFile()) {
      throw new Error(`Android build returned an invalid APK path for ${serial}`);
    }
    if (deps.readPackageId(producedApk) !== PACKAGE_ID) {
      throw new Error(`Produced APK has unexpected package id (expected ${PACKAGE_ID})`);
    }
    const stagedApk = path.join(staging, 'Kilo.apk');
    if (path.resolve(producedApk) !== path.resolve(stagedApk))
      fs.copyFileSync(producedApk, stagedApk);
    const manifest: AndroidManifest = {
      key,
      ...compatibility,
      packageId: PACKAGE_ID,
      artifactChecksum: await hashFile(stagedApk),
      producerWorktree: deps.worktreeRoot,
      createdAt: deps.now().toISOString(),
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
    const finalDir = path.join(deps.cacheRoot, 'entries', key);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    let concurrentPublish = false;
    try {
      fs.renameSync(staging, finalDir);
    } catch (error) {
      if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
      concurrentPublish = true;
    }
    const verified = await lookup(deps.cacheRoot, key, compatibility, deps.readPackageId);
    if (!verified) {
      throw new Error(
        concurrentPublish
          ? `Concurrent Android cache entry is invalid for ${key}`
          : `Android cache entry failed post-publish validation for ${key}`
      );
    }
    return verified;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function isManifest(
  value: unknown,
  key: string,
  compatibility: AndroidCompatibility
): value is AndroidManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.key === key &&
    manifest.nativeHash === compatibility.nativeHash &&
    manifest.gradleVersion === compatibility.gradleVersion &&
    manifest.javaVersion === compatibility.javaVersion &&
    manifest.androidSdkIdentity === compatibility.androidSdkIdentity &&
    manifest.hostArch === compatibility.hostArch &&
    manifest.buildMode === BUILD_MODE &&
    manifest.packageId === PACKAGE_ID &&
    typeof manifest.artifactChecksum === 'string' &&
    /^[0-9a-f]{64}$/.test(manifest.artifactChecksum) &&
    typeof manifest.producerWorktree === 'string' &&
    typeof manifest.createdAt === 'string' &&
    !Number.isNaN(Date.parse(manifest.createdAt)) &&
    new Date(manifest.createdAt).toISOString() === manifest.createdAt
  );
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function isWithinRealPath(candidate: string, parent: string): boolean {
  let realCandidate: string;
  let realParent: string;
  try {
    realCandidate = fs.realpathSync(candidate);
    realParent = fs.realpathSync(parent);
  } catch {
    return false;
  }
  const relative = path.relative(realParent, realCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function pruneAndroidCache(
  cacheRoot: string,
  now = new Date(),
  retentionMs = 14 * 24 * 60 * 60 * 1000
): { removed: string[]; kept: string[] } {
  const entriesRoot = path.join(cacheRoot, 'entries');
  const removed: string[] = [];
  const kept: string[] = [];
  if (!fs.existsSync(entriesRoot)) return { removed, kept };
  for (const key of fs.readdirSync(entriesRoot).sort()) {
    const entry = path.join(entriesRoot, key);
    let createdAt: unknown;
    try {
      createdAt = JSON.parse(fs.readFileSync(path.join(entry, 'manifest.json'), 'utf8')).createdAt;
    } catch {
      const age = now.getTime() - fs.statSync(entry).mtimeMs;
      if (age < retentionMs) {
        kept.push(key);
        continue;
      }
      fs.rmSync(entry, { recursive: true, force: true });
      removed.push(key);
      continue;
    }
    const timestamp = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
    if (Number.isNaN(timestamp) || now.getTime() - timestamp >= retentionMs) {
      fs.rmSync(entry, { recursive: true, force: true });
      removed.push(key);
    } else {
      kept.push(key);
    }
  }
  return { removed, kept };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
