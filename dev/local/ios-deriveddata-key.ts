// Print `key=<sha256>` for the DerivedData tree of a workflow's iOS simulator
// Release build. A restored tree is only usable against the same native inputs,
// toolchain and build recipe, so the key covers exactly those dimensions and
// nothing else: a repository file the build reads through node_modules is
// already pinned by the native hash.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createProjectHashAsync } from '@expo/fingerprint';

import {
  buildFingerprintOptions,
  mobileRoot,
  querySimulatorSdkVersion,
  queryXcodeBuildVersion,
} from './mobile-ios-build';

export type DerivedDataDimensions = {
  buildMode: 'release-simulator';
  hostArch: string;
  nativeHash: string;
  simulatorSdkVersion: string;
  workflowDigest: string;
  xcodeBuildVersion: string;
};

// JSON key order is sorted so the key is stable across implementations.
export function buildDerivedDataKey(dimensions: DerivedDataDimensions): string {
  const ordered = {
    buildMode: dimensions.buildMode,
    hostArch: dimensions.hostArch,
    nativeHash: dimensions.nativeHash,
    simulatorSdkVersion: dimensions.simulatorSdkVersion,
    workflowDigest: dimensions.workflowDigest,
    xcodeBuildVersion: dimensions.xcodeBuildVersion,
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

// The workflow holds the xcodebuild arguments and the recipe that shape the
// tree, so its bytes are an input. A checkout before this step existed hashes
// its own older file and misses, which costs the build that empty tree pays.
export function fileDigest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main(): Promise<void> {
  const workflow = process.argv[2];
  if (!workflow) {
    throw new Error('Usage: tsx dev/local/ios-deriveddata-key.ts <workflow-file>');
  }
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const nativeHash = await createProjectHashAsync(
    mobileRoot(),
    buildFingerprintOptions() as Parameters<typeof createProjectHashAsync>[1]
  );
  const key = buildDerivedDataKey({
    buildMode: 'release-simulator',
    hostArch: process.arch,
    nativeHash,
    simulatorSdkVersion: querySimulatorSdkVersion(),
    workflowDigest: fileDigest(path.resolve(repoRoot, workflow)),
    xcodeBuildVersion: queryXcodeBuildVersion(),
  });
  process.stdout.write(`key=${key}\n`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
