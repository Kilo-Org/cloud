import { microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import { and, count, desc, eq, gt, inArray, isNull, sql, sum, type SQL } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> [--since <ISO-8601>] [--session-id <id>]...';

const classifierModel = 'auto-routing/classifier';
const sampleLimit = 100;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:usage-evidence ${usage}`);
  console.log('');
  console.log(
    'SQL aggregates cover ALL currently matching rows, including errors and classifier cost.'
  );
  console.log(
    'inference* and classifier* totals are separate; gross input already includes cache tokens.'
  );
  console.log('marketMicrodollars sums known costs only; missing costs remain explicitly counted.');
  console.log(
    'Legacy rows/truncated/sampled*/latest*/BYOK diagnostics cover only the newest 100 rows.'
  );
  console.log(
    'Fields ending in Json encode arrays within the flat result; sampleRowsJson is bounded.'
  );
  console.log(
    'Cost/token integers beyond the safe JSON number range are returned as decimal strings.'
  );
  console.log(
    'Unattributed totals cover missing-session rows in the same user/since window, not the run.'
  );
  console.log(
    'Run accounting is always unproven: the session mapping and pending usage are unknown.'
  );
  console.log(
    'These tables do not store client request IDs; a nontruncated sample proves no completeness.'
  );
  console.log('Aggregates and samples are separate observations. Read-only; never writes.');
  console.log('');
  console.log('Options:');
  console.log(
    '  --since <ISO-8601>   Only rows created after this instant (default: 48 hours ago).'
  );
  console.log('                      Pass an earlier timestamp to opt in to older history.');
  console.log(
    '  --session-id <id>    Match this session; repeat for root/child/retry sessions (OR).'
  );
  console.log(
    '                      One ID remains session-level inspection, not whole-run proof.'
  );
  console.log('');
  console.log('Examples:');
  console.log(
    '  pnpm -s dev:seed app:usage-evidence ada@example.com --json | jq -r .byokLatestModel'
  );
  console.log(
    '  pnpm -s dev:seed app:usage-evidence ada@example.com --since 2026-08-07T12:00:00Z --session-id root --session-id child --json'
  );
}

type UsageEvidenceOptions = {
  email: string;
  since: string | null;
  sessionIds: string[];
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
  const sessionIds = new Set<string>();
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
    if (arg === '--session-id') {
      const value = args[index + 1]?.trim();
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--session-id requires a nonempty session id');
      }
      sessionIds.add(value);
      index += 2;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { email, since, sessionIds: [...sessionIds] };
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

function exactSum(values: Array<string | number | null>): number | string {
  const total = values.reduce<bigint>((total, value) => total + BigInt(value ?? 0), 0n);
  const numeric = Number(total);
  return Number.isSafeInteger(numeric) ? numeric : total.toString();
}

async function readAggregates(condition: SQL | undefined) {
  return getSeedDb()
    .select({
      sessionId: microdollar_usage_metadata.session_id,
      model: microdollar_usage.model,
      requestedModel: microdollar_usage.requested_model,
      provider: microdollar_usage.provider,
      statusCode: microdollar_usage_metadata.status_code,
      rows: count(),
      billedMicrodollars: sum(microdollar_usage.cost),
      marketMicrodollars: sum(microdollar_usage_metadata.market_cost),
      grossInputTokens: sum(microdollar_usage.input_tokens),
      outputTokens: sum(microdollar_usage.output_tokens),
      cacheReadTokens: sum(microdollar_usage.cache_hit_tokens),
      cacheWriteTokens: sum(microdollar_usage.cache_write_tokens),
      byokTrueRows:
        sql<number>`count(*) filter (where ${microdollar_usage_metadata.is_user_byok} is true)`.mapWith(
          Number
        ),
      byokFalseRows:
        sql<number>`count(*) filter (where ${microdollar_usage_metadata.is_user_byok} is false)`.mapWith(
          Number
        ),
      byokUnknownRows:
        sql<number>`count(*) filter (where ${microdollar_usage_metadata.is_user_byok} is null)`.mapWith(
          Number
        ),
      missingMetadataRows:
        sql<number>`count(*) filter (where ${microdollar_usage_metadata.id} is null)`.mapWith(
          Number
        ),
      missingMarketCostRows:
        sql<number>`count(*) filter (where ${microdollar_usage_metadata.market_cost} is null)`.mapWith(
          Number
        ),
      successRows:
        sql<number>`count(*) filter (where ${microdollar_usage.has_error} is false)`.mapWith(
          Number
        ),
      errorRows:
        sql<number>`count(*) filter (where ${microdollar_usage.has_error} is true)`.mapWith(Number),
    })
    .from(microdollar_usage)
    .leftJoin(microdollar_usage_metadata, eq(microdollar_usage_metadata.id, microdollar_usage.id))
    .where(condition)
    .groupBy(
      microdollar_usage_metadata.session_id,
      microdollar_usage.model,
      microdollar_usage.requested_model,
      microdollar_usage.provider,
      microdollar_usage_metadata.status_code
    );
}

type UsageGroup = Awaited<ReturnType<typeof readAggregates>>[number];

function summarize(groups: UsageGroup[]) {
  return {
    rows: groups.reduce((total, group) => total + group.rows, 0),
    billedMicrodollars: exactSum(groups.map(group => group.billedMicrodollars)),
    marketMicrodollars: groups.some(group => group.marketMicrodollars !== null)
      ? exactSum(groups.map(group => group.marketMicrodollars))
      : null,
    grossInputTokens: exactSum(groups.map(group => group.grossInputTokens)),
    outputTokens: exactSum(groups.map(group => group.outputTokens)),
    cacheReadTokens: exactSum(groups.map(group => group.cacheReadTokens)),
    cacheWriteTokens: exactSum(groups.map(group => group.cacheWriteTokens)),
    byokTrueRows: groups.reduce((total, group) => total + group.byokTrueRows, 0),
    byokFalseRows: groups.reduce((total, group) => total + group.byokFalseRows, 0),
    byokUnknownRows: groups.reduce((total, group) => total + group.byokUnknownRows, 0),
    missingMetadataRows: groups.reduce((total, group) => total + group.missingMetadataRows, 0),
    missingMarketCostRows: groups.reduce((total, group) => total + group.missingMarketCostRows, 0),
    successRows: groups.reduce((total, group) => total + group.successRows, 0),
    errorRows: groups.reduce((total, group) => total + group.errorRows, 0),
  };
}

function prefixedSummary(prefix: string, groups: UsageGroup[]): SeedResult {
  return Object.fromEntries(
    Object.entries(summarize(groups)).map(([key, value]) => [
      `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      value,
    ])
  );
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email, since: requestedSince, sessionIds } = parseArgs(args);
  const since = requestedSince ?? new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const userId = await resolveSeedUserId(email);
  const db = getSeedDb();

  const windowConditions = [
    eq(microdollar_usage.kilo_user_id, userId),
    gt(microdollar_usage.created_at, since),
  ];
  const conditions = [...windowConditions];
  const firstSessionId = sessionIds[0];
  if (firstSessionId !== undefined) {
    conditions.push(
      sessionIds.length === 1
        ? eq(microdollar_usage_metadata.session_id, firstSessionId)
        : inArray(microdollar_usage_metadata.session_id, sessionIds)
    );
  }

  const groups = await readAggregates(and(...conditions));
  const { rows: matchedRows, ...totals } = summarize(groups);
  const unattributedGroups = sessionIds.length
    ? await readAggregates(and(...windowConditions, isNull(microdollar_usage_metadata.session_id)))
    : groups.filter(group => group.sessionId === null);
  const observedSessionIds = new Set(
    groups.flatMap(group => (group.sessionId === null ? [] : [group.sessionId]))
  );

  const matchingRows = await db
    .select({
      id: microdollar_usage.id,
      createdAt: microdollar_usage.created_at,
      model: microdollar_usage.model,
      requestedModel: microdollar_usage.requested_model,
      provider: microdollar_usage.provider,
      hasError: microdollar_usage.has_error,
      cost: sql<string>`${microdollar_usage.cost}`.mapWith(String),
      inputTokens: sql<string>`${microdollar_usage.input_tokens}`.mapWith(String),
      outputTokens: sql<string>`${microdollar_usage.output_tokens}`.mapWith(String),
      cacheWriteTokens: sql<string>`${microdollar_usage.cache_write_tokens}`.mapWith(String),
      cacheHitTokens: sql<string>`${microdollar_usage.cache_hit_tokens}`.mapWith(String),
      isUserByok: microdollar_usage_metadata.is_user_byok,
      statusCode: microdollar_usage_metadata.status_code,
      sessionId: microdollar_usage_metadata.session_id,
      metadataId: microdollar_usage_metadata.id,
      marketCost: sql<string | null>`${microdollar_usage_metadata.market_cost}`.mapWith(String),
    })
    .from(microdollar_usage)
    .leftJoin(microdollar_usage_metadata, eq(microdollar_usage_metadata.id, microdollar_usage.id))
    .where(and(...conditions))
    .orderBy(desc(microdollar_usage.created_at))
    .limit(sampleLimit + 1);
  const rows = matchingRows.slice(0, sampleLimit);

  const effectiveModel = (row: (typeof rows)[number]): string | null =>
    row.model ?? row.requestedModel;
  const byokRows = rows.filter(row => row.isUserByok === true);
  const nonByokRows = rows.filter(row => row.isUserByok === false);
  const latest = rows[0];
  const byokLatest = byokRows[0];

  return {
    userId,
    since,
    sessionId: sessionIds.length === 1 ? (firstSessionId ?? null) : null,
    sessionIdsJson: JSON.stringify(sessionIds),
    observedSessionIdsJson: JSON.stringify([...observedSessionIds].sort()),
    sessionsWithoutUsageJson: JSON.stringify(sessionIds.filter(id => !observedSessionIds.has(id))),
    scope:
      sessionIds.length === 0 ? 'user-window' : sessionIds.length === 1 ? 'session' : 'session-set',
    aggregateCompleteness: 'all-matched-rows-at-query-time',
    runAccountingCompleteness: 'unproven',
    runAccountingReason:
      'Session mapping, expected requests and pending usage/metadata are unknown.',
    marketCostCompleteness:
      matchedRows === totals.missingMarketCostRows
        ? 'unknown'
        : totals.missingMarketCostRows > 0
          ? 'partial'
          : 'complete-for-matched-rows',
    matchedRows,
    ...totals,
    ...prefixedSummary(
      'inference',
      groups.filter(group => group.model !== classifierModel)
    ),
    ...prefixedSummary(
      'classifier',
      groups.filter(group => group.model === classifierModel)
    ),
    ...prefixedSummary('unattributed', unattributedGroups),
    distributionJson: JSON.stringify(
      groups.map(group => ({
        ...group,
        ...summarize([group]),
        kind: group.model === classifierModel ? 'classifier' : 'inference',
      }))
    ),
    sampleRowsJson: JSON.stringify(
      rows.map(row => ({
        id: row.id,
        createdAt: new Date(row.createdAt).toISOString(),
        model: row.model,
        requestedModel: row.requestedModel,
        provider: row.provider,
        kind: row.model === classifierModel ? 'classifier' : 'inference',
        hasError: row.hasError,
        billedMicrodollars: exactSum([row.cost]),
        marketMicrodollars: row.marketCost === null ? null : exactSum([row.marketCost]),
        grossInputTokens: exactSum([row.inputTokens]),
        outputTokens: exactSum([row.outputTokens]),
        cacheReadTokens: exactSum([row.cacheHitTokens]),
        cacheWriteTokens: exactSum([row.cacheWriteTokens]),
        isUserByok: row.isUserByok,
        statusCode: row.statusCode,
        sessionId: row.sessionId,
        metadataPresent: row.metadataId !== null,
      }))
    ),
    rows: rows.length,
    truncated: matchingRows.length > sampleLimit,
    sampledCostMicrodollars: exactSum(rows.map(row => row.cost)),
    sampledMarketCostMicrodollars: rows.some(row => row.marketCost !== null)
      ? exactSum(rows.map(row => row.marketCost))
      : null,
    sampledInputTokens: exactSum(rows.map(row => row.inputTokens)),
    sampledOutputTokens: exactSum(rows.map(row => row.outputTokens)),
    sampledCacheWriteTokens: exactSum(rows.map(row => row.cacheWriteTokens)),
    sampledCacheHitTokens: exactSum(rows.map(row => row.cacheHitTokens)),
    byokRows: byokRows.length,
    nonByokRows: nonByokRows.length,
    unknownByokRows: rows.length - byokRows.length - nonByokRows.length,
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
    nonByokSessionIds: dedupeJoined(nonByokRows.map(row => row.sessionId)),
    unknownByokSessionIds: dedupeJoined(
      rows.filter(row => row.isUserByok === null).map(row => row.sessionId)
    ),
  };
}
