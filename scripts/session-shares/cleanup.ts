import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';
import {
  CleanupUsageError,
  runCleanup,
  targetUsesV1,
  type BlobStore,
  type CleanupMode,
} from './cleanup-core';
import {
  CLEANUP_TARGETS,
  ManifestError,
  createFileManifestStore,
  databaseIdentityHash,
  type CleanupTarget,
} from './manifest';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_ATTEMPTS = 3;

type CliOptions = {
  mode: CleanupMode;
  target: CleanupTarget;
  manifestPath: string | null;
  batchSize: number;
  maxAttempts: number;
};

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function usage(): never {
  console.error(`Usage:
  pnpm session-shares:cleanup --target <v2-webhook-bot|v1-publisher-mismatch|all> [--manifest <path>] [--batch-size <n>] [--max-attempts <n>]
  pnpm session-shares:cleanup --apply --target <...> --manifest <path> [--batch-size <n>] [--max-attempts <n>]

Dry-run is the default. Apply requires --apply and a private manifest path outside the repository.
Set POSTGRES_URL (or USE_PRODUCTION_DB=true with POSTGRES_URL_PRODUCTION) before running.`);
  process.exit(1);
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CleanupUsageError(`Missing value for ${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CleanupUsageError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseTarget(value: string): CleanupTarget {
  if (!(CLEANUP_TARGETS as readonly string[]).includes(value)) {
    throw new CleanupUsageError(`Unknown target: ${value}`);
  }
  return value as CleanupTarget;
}

function parseArgs(args: string[]): CliOptions {
  let apply = false;
  let dryRun = false;
  let target: CleanupTarget | null = null;
  let manifestPath: string | null = null;
  let batchSize = DEFAULT_BATCH_SIZE;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--help':
      case '-h':
        usage();
        break;
      case '--apply':
        apply = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--target':
        target = parseTarget(requireValue(args, index, argument));
        index += 1;
        break;
      case '--manifest':
        manifestPath = requireValue(args, index, argument);
        index += 1;
        break;
      case '--batch-size':
        batchSize = parsePositiveInteger(requireValue(args, index, argument), argument);
        index += 1;
        break;
      case '--max-attempts':
        maxAttempts = parsePositiveInteger(requireValue(args, index, argument), argument);
        index += 1;
        break;
      default:
        throw new CleanupUsageError(`Unknown argument: ${argument}`);
    }
  }

  if (apply && dryRun) {
    throw new CleanupUsageError('Choose either --apply or --dry-run, not both');
  }
  if (!target) {
    throw new CleanupUsageError('An explicit --target is required');
  }
  if (apply && !manifestPath) {
    throw new CleanupUsageError(
      'Apply mode requires --manifest with a private path outside the repository'
    );
  }
  if (batchSize > 1_000) {
    throw new CleanupUsageError('Batch size must not exceed 1000');
  }
  if (maxAttempts > 10) {
    throw new CleanupUsageError('Max attempts must not exceed 10');
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    target,
    manifestPath,
    batchSize,
    maxAttempts,
  };
}

async function createR2BlobStore(): Promise<BlobStore> {
  const { deleteBlobs } = await import('../../apps/web/src/lib/r2/cli-sessions');
  return {
    async deleteShareBlobs(shareId, filenames, options) {
      await deleteBlobs(
        shareId,
        filenames.map(filename => ({ folderName: 'shared-sessions', filename })),
        options
      );
    },
  };
}

function redactPublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Operation failed';
  return `${error instanceof Error ? error.name : 'Error'}: ${message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<token>')
    .replace(/shared-sessions\/[^\s"']+/g, 'shared-sessions/<redacted>')}`;
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), '.env.local'));
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const options = parseArgs(process.argv.slice(2));
  const connectionString = computeDatabaseUrl();
  const { db, pool } = createDrizzleClient({
    connectionString,
    poolConfig: { max: 1, application_name: 'kilocode-session-share-cleanup' },
  });

  try {
    const manifestStore = options.manifestPath
      ? createFileManifestStore(options.manifestPath)
      : null;
    const blobStore =
      options.mode === 'apply' && targetUsesV1(options.target) ? await createR2BlobStore() : null;

    const report = await runCleanup({
      db,
      mode: options.mode,
      target: options.target,
      databaseIdentityHash: databaseIdentityHash(connectionString),
      batchSize: options.batchSize,
      maxAttempts: options.maxAttempts,
      manifestStore,
      blobStore,
      onBatch: event => {
        console.error(
          `[${event.phase}] ${event.kind} batch ${event.batch_index}: ${event.size} row(s)`
        );
      },
    });

    console.log(JSON.stringify(report, null, 2));
    if (options.mode === 'apply' && !report.apply?.complete) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  if (error instanceof CleanupUsageError || error instanceof ManifestError) {
    console.error(error.message);
  } else {
    console.error(redactPublicError(error));
  }
  process.exit(1);
});
