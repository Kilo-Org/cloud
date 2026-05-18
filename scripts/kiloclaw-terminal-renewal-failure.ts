#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  computeDatabaseUrl,
  createDrizzleClient,
  listUnresolvedTerminalRenewalFailures,
  markTerminalRenewalFailureResolved,
  markTerminalRenewalFailureWaived,
} from '@kilocode/db';

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    const value = rawValue.replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requireArg(args: string[], name: string): string {
  const value = getArg(args, name);
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function printUsage(): never {
  console.error(`Usage:
  pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts list [--subscription-id <id>] [--limit <n>]
  pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts resolve --subscription-id <id> --renewal-boundary <iso> --actor-id <id> --reason <text>
  pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts waive --subscription-id <id> --renewal-boundary <iso> --actor-id <id> --reason <text>
  pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts retry-message --subscription-id <id> --renewal-boundary <iso> [--run-id <uuid>] [--user-id <id>]

Set POSTGRES_URL (or USE_PRODUCTION_DB=true with POSTGRES_URL_PRODUCTION) before list/resolve/waive.`);
  process.exit(1);
}

function createDb() {
  loadEnvFile(resolve(process.cwd(), '.env.local'));
  loadEnvFile(resolve(process.cwd(), '.env'));
  return createDrizzleClient({ connectionString: computeDatabaseUrl(), poolConfig: { max: 1 } });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') printUsage();

  if (command === 'retry-message') {
    const subscriptionId = requireArg(args, '--subscription-id');
    const renewalBoundary = requireArg(args, '--renewal-boundary');
    const runId = getArg(args, '--run-id') ?? crypto.randomUUID();
    const userId = getArg(args, '--user-id');

    console.log(
      JSON.stringify(
        {
          kind: 'credit_renewal_item',
          runId,
          sweep: 'credit_renewal_item',
          subscriptionId,
          ...(userId ? { userId } : {}),
          renewalBoundary,
          discoveredAt: new Date().toISOString(),
          resolveTerminalFailureOnExpectedOutcome: true,
        },
        null,
        2
      )
    );
    return;
  }

  const { db, pool } = createDb();
  try {
    if (command === 'list') {
      const subscriptionId = getArg(args, '--subscription-id');
      const limitValue = getArg(args, '--limit');
      const limit = limitValue ? Number(limitValue) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('--limit must be a positive integer');
      }

      const rows = await listUnresolvedTerminalRenewalFailures(db, { subscriptionId, limit });
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (command === 'resolve' || command === 'waive') {
      const input = {
        subscriptionId: requireArg(args, '--subscription-id'),
        renewalBoundary: requireArg(args, '--renewal-boundary'),
        actor: {
          type: 'operator' as const,
          id: requireArg(args, '--actor-id'),
        },
        reason: requireArg(args, '--reason'),
        resolvedAt: new Date().toISOString(),
      };

      const row =
        command === 'resolve'
          ? await markTerminalRenewalFailureResolved(db, input)
          : await markTerminalRenewalFailureWaived(db, input);

      if (!row) {
        console.error('No unresolved terminal renewal failure matched the supplied boundary.');
        process.exitCode = 2;
        return;
      }

      console.log(JSON.stringify(row, null, 2));
      return;
    }

    printUsage();
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
