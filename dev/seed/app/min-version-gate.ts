import { app_min_versions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

/**
 * Raises the LOCAL minimum app version so the root layout's gate
 * (`apps/mobile/src/app/_layout.tsx`) sends the app to `/force-update`, and
 * puts it back. `app_min_versions` holds one row, and both platforms move
 * together: the app sends `x-kilo-app-platform`, so a single-platform raise
 * would leave the other lane unblocked.
 *
 * The value must be plain dotted digits. `isVersionBelow` splits on `.` and
 * coerces a non-numeric segment to 0, so `v9.9.9` compares as `0.9.9` and
 * silently passes every client.
 */
const RAISED_VERSION = '9.9.9';
/** The column defaults: what a fresh local database seeds itself with. */
const BASELINE_VERSION = '1.0.0';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:min-version-gate [--reset] [--version <v>]');
  console.log(`Seeds the local app_min_versions row at ${RAISED_VERSION} for both platforms.`);
  console.log(`--reset puts it back to ${BASELINE_VERSION} (the column default).`);
  console.log('--version <v> raises to another plain dotted version instead.');
  console.log('Requires a loopback database. The app checks on cold start, on foreground,');
  console.log('on network recovery and after a server refusal; there is no timer.');
  console.log('The server reads the row through a per-instance cache and the REST check');
  console.log('is cached for 300 s, so restart nextjs (pnpm dev:restart nextjs) and');
  console.log('relaunch the app when the change must be visible at once.');
}

function readVersionArg(args: readonly string[]): string | null {
  const inline = args.find(arg => arg.startsWith('--version='));
  if (inline) {
    return inline.slice('--version='.length);
  }
  const index = args.indexOf('--version');
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--version needs a value, such as --version 9.9.9.');
  }
  return value;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const reset = args.includes('--reset');
  for (const [index, arg] of args.entries()) {
    if (arg === '--reset' || arg.startsWith('--version=') || arg === '--version') {
      continue;
    }
    // The value that follows `--version` is consumed by the flag itself.
    if (args[index - 1] === '--version') {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  const requested = readVersionArg(args);
  if (reset && requested !== null) {
    throw new Error('--reset and --version cannot be combined.');
  }
  const targetVersion = reset ? BASELINE_VERSION : (requested ?? RAISED_VERSION);
  if (!VERSION_PATTERN.test(targetVersion)) {
    throw new Error(
      `The minimum version must be plain dotted digits (e.g. ${RAISED_VERSION}), not "${targetVersion}".`
    );
  }

  assertLocalSeedDatabase('app:min-version-gate');
  const db = getSeedDb();
  const nextStep = reset
    ? 'Restart nextjs (pnpm dev:restart nextjs), then cold-start the app: it leaves /force-update.'
    : 'Restart nextjs (pnpm dev:restart nextjs), then open the app (kiloapp://) to land on /force-update.';
  const [existing] = await db.select().from(app_min_versions).limit(1);
  const values = {
    ios_min_version: targetVersion,
    android_min_version: targetVersion,
    updated_at: new Date().toISOString(),
  };

  if (!existing) {
    await db.insert(app_min_versions).values(values);
    console.log(`No minimum-version row existed; inserted ${targetVersion} for both platforms.`);
    return {
      mode: reset ? 'reset' : 'raise',
      version: targetVersion,
      previousIos: null,
      previousAndroid: null,
      rowId: null,
      nextStep,
    };
  }

  await db.update(app_min_versions).set(values).where(eq(app_min_versions.id, existing.id));
  console.log(
    `Minimum version ${existing.ios_min_version}/${existing.android_min_version} → ${targetVersion}/${targetVersion}.`
  );
  console.log(
    reset
      ? 'The next cold start leaves /force-update and resumes the app.'
      : 'The next cold start, foreground resume or server refusal blocks on /force-update.'
  );
  return {
    mode: reset ? 'reset' : 'raise',
    version: targetVersion,
    previousIos: existing.ios_min_version,
    previousAndroid: existing.android_min_version,
    rowId: existing.id,
    nextStep,
  };
}
