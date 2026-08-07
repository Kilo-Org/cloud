import { kilocode_users, microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import { and, desc, eq, gt, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<email> [--since <ISO-8601>]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:usage-evidence ${usage}`);
  console.log('');
  console.log('Reads microdollar usage rows for the user, newest first, capped at 100.');
  console.log('Left-joins usage metadata and reports BYOK evidence as flat primitives.');
  console.log('Read-only; never writes.');
  console.log('');
  console.log('Options:');
  console.log('  --since <ISO-8601>   Only rows created after this instant.');
  console.log('');
  console.log('Examples:');
  console.log(
    '  pnpm -s dev:seed app:usage-evidence ada@example.com --json | jq -r .byokLatestModel'
  );
  console.log(
    '  pnpm -s dev:seed app:usage-evidence ada@example.com --since 2026-08-07T12:00:00Z --json'
  );
}

function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function resolveUserId(email: string): Promise<string> {
  const normalizedEmail = normalizeSeedEmail(email);
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(`No user found for email ${email}`);
  }

  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${matchList}`);
  }

  const [user] = resolvedMatches;
  return user.userId;
}

type UsageEvidenceOptions = {
  email: string;
  since: string | null;
};

function parseArgs(args: string[]): UsageEvidenceOptions {
  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  let since: string | null = null;
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--since') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--since requires an ISO-8601 timestamp value');
      }
      if (Number.isNaN(Date.parse(value))) {
        throw new Error(`--since is not a valid ISO-8601 timestamp: ${value}`);
      }
      since = new Date(value).toISOString();
      index += 2;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { email, since };
}

function dedupeJoined(values: Array<string | number | null>): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  return unique.join(',');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email, since } = parseArgs(args);
  const userId = await resolveUserId(email);
  const db = getSeedDb();

  // Filter first, then cap: a --since window never discards an in-window row.
  const conditions = [eq(microdollar_usage.kilo_user_id, userId)];
  if (since) {
    conditions.push(gt(microdollar_usage.created_at, since));
  }

  // Plan section 317: select every plan-required per-row field. The metadata half can be
  // null for a row without it, so all metadata fields stay nullable-safe in the row type.
  const rows = await db
    .select({
      id: microdollar_usage.id,
      createdAt: microdollar_usage.created_at,
      model: microdollar_usage.model,
      requestedModel: microdollar_usage.requested_model,
      provider: microdollar_usage.provider,
      hasError: microdollar_usage.has_error,
      cost: microdollar_usage.cost,
      isUserByok: microdollar_usage_metadata.is_user_byok,
      statusCode: microdollar_usage_metadata.status_code,
      sessionId: microdollar_usage_metadata.session_id,
      marketCost: microdollar_usage_metadata.market_cost,
    })
    .from(microdollar_usage)
    .leftJoin(microdollar_usage_metadata, eq(microdollar_usage_metadata.id, microdollar_usage.id))
    .where(and(...conditions))
    .orderBy(desc(microdollar_usage.created_at))
    .limit(100);

  // A row's model falls back to requested_model for upstream-rejected requests.
  const effectiveModel = (row: (typeof rows)[number]): string | null =>
    row.model ?? row.requestedModel;
  const byokRows = rows.filter(row => row.isUserByok === true);
  const latest = rows[0];
  const byokLatest = byokRows[0];

  return {
    userId,
    rows: rows.length,
    byokRows: byokRows.length,
    nonByokRows: rows.length - byokRows.length,
    latestCreatedAt: latest ? new Date(latest.createdAt).toISOString() : null,
    latestModel: latest ? effectiveModel(latest) : null,
    latestProvider: latest?.provider ?? null,
    latestIsUserByok: latest?.isUserByok ?? null,
    latestStatusCode: latest?.statusCode ?? null,
    latestSessionId: latest?.sessionId ?? null,
    byokLatestCreatedAt: byokLatest ? new Date(byokLatest.createdAt).toISOString() : null,
    byokLatestModel: byokLatest ? effectiveModel(byokLatest) : null,
    byokLatestProvider: byokLatest?.provider ?? null,
    byokLatestSessionId: byokLatest?.sessionId ?? null,
    byokSessionIds: dedupeJoined(byokRows.map(row => row.sessionId)),
    byokStatusCodes: dedupeJoined(byokRows.map(row => row.statusCode)),
    nonByokSessionIds: dedupeJoined(
      rows.filter(row => row.isUserByok !== true).map(row => row.sessionId)
    ),
  };
}
