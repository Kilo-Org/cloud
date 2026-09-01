// Print the platform's nativeHash and exit. Unlike `dev:mobile:ios
// fingerprint`, this needs no Xcode or Android SDK, so CI gates can run it
// on any Linux runner to decide whether a native build is required.
import path from 'node:path';

import { createProjectHashAsync } from '@expo/fingerprint';

import { buildAndroidFingerprintOptions } from './mobile-android-build';
import { buildFingerprintOptions, mobileRoot } from './mobile-ios-build';

async function main(): Promise<void> {
  const platform = process.argv[2];
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Usage: tsx dev/local/mobile-native-hash.ts <ios|android>');
  }
  const options = platform === 'ios' ? buildFingerprintOptions() : buildAndroidFingerprintOptions();
  const hash = await createProjectHashAsync(
    mobileRoot(),
    options as Parameters<typeof createProjectHashAsync>[1]
  );
  process.stdout.write(`${hash}\n`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
