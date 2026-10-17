import {
  CustomRouterEntriesSchema,
  CustomRouterScopeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST,
  OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES,
  OWNER_POOL_CONVERSION_PATH,
  OwnerPoolConversionOutcomeSchema,
  OwnerPoolConversionResponseSchema,
  convertedOwnerPoolRouter,
  type CustomRouterScope,
  type OwnerPoolConversion,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionResult,
  type OwnerPoolConversionScanResponse,
} from '@kilocode/auto-routing-contracts';
import { getWorkerDb, kilocode_users, organizations } from '@kilocode/db';
import { asc, gt } from 'drizzle-orm';
import type { Handler } from 'hono';
import * as z from 'zod';
import type { HonoEnv } from './hono-env';
import type { StoredOwnerSettings } from './routing-mode';

const READ_CONCURRENCY = 10;
const OUTAGE_CONSECUTIVE_FAILURES = 5;
// A batch's conversions and notices run in sequence on the web side; the batch size keeps one well
// inside this, so a timeout means the endpoint is stuck rather than slow.
const BATCH_TIMEOUT_MS = 90_000;
// No new batch starts after this, so a page plus its last batch ends well inside the operator
// script's 300 s request timeout.
const PAGE_POST_BUDGET_MS = 150_000;

type AbortReason = 'batch_failed' | 'consecutive_failures';

const ScanRequestSchema = z.object({
  ownerType: CustomRouterScopeSchema,
  objectIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  after: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(10_000).default(2_000),
  dryRun: z.boolean(),
  // Carried from the previous page so sparse pages still detect an outage.
  consecutiveFailed: z.number().int().min(0).default(0),
});

export type OwnerObjectMatch = { ownerId: string; objectId: string };

export function matchOwnerObjects(
  ownerType: CustomRouterScope,
  ownerIds: readonly string[],
  objectIds: ReadonlySet<string>,
  idFor: (name: string) => string
): OwnerObjectMatch[] {
  return ownerIds.flatMap(ownerId => {
    const objectId = idFor(`${ownerType}:${ownerId}`);
    return objectIds.has(objectId) ? [{ ownerId, objectId }] : [];
  });
}

async function listOwnerIds(
  env: Env,
  ownerType: CustomRouterScope,
  after: string | null,
  limit: number
): Promise<string[]> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const rows =
    ownerType === 'user'
      ? await db
          .select({ id: kilocode_users.id })
          .from(kilocode_users)
          .where(after === null ? undefined : gt(kilocode_users.id, after))
          .orderBy(asc(kilocode_users.id))
          .limit(limit)
      : await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(after === null ? undefined : gt(organizations.id, after))
          .orderBy(asc(organizations.id))
          .limit(limit);
  return rows.map(row => row.id);
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    })
  );
  return results;
}

async function postChunk(
  url: URL,
  secret: string,
  chunk: readonly OwnerPoolConversion[]
): Promise<OwnerPoolConversionResult[] | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ conversions: chunk }),
      signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      // The internal secret must never follow a redirect.
      redirect: 'error',
    });
    if (!response.ok) return null;
    const parsed = OwnerPoolConversionResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.results.length !== chunk.length) return null;
    const inOrder = parsed.data.results.every(
      (result, index) =>
        result.owner.type === chunk[index]?.owner.type && result.owner.id === chunk[index]?.owner.id
    );
    return inOrder ? parsed.data.results : null;
  } catch {
    return null;
  }
}

/**
 * Posts the page in batches and records each batch's results (`onBatch`) as soon as it returns, so
 * an interrupted page never leaves converted owners unmarked.
 *
 * A batch request that fails or times out, or OUTAGE_CONSECUTIVE_FAILURES `failed` results in a row
 * (counted across batches and, through the request, across pages), means the web endpoint looks
 * unavailable: the owners from that batch on are returned as `notPosted`. Owners that failed in an
 * earlier attempt neither extend nor reset the run, so retrying them cannot fake an outage. No
 * batch starts once the page has run PAGE_POST_BUDGET_MS; the page then ends early and the next
 * page resumes after the last owner posted (`stoppedAfter`).
 */
async function postConversions(params: {
  env: Env;
  conversions: readonly OwnerPoolConversion[];
  pageStartedAt: number;
  previousConsecutiveFailed: number;
  previouslyFailed: ReadonlySet<string>;
  onBatch: (results: readonly OwnerPoolConversionResult[]) => Promise<void>;
}): Promise<{
  results: OwnerPoolConversionResult[];
  notPosted: OwnerPoolConversion[];
  abortReason: AbortReason | null;
  consecutiveFailed: number;
  stoppedAfter: string | null;
}> {
  const { conversions, previouslyFailed, onBatch } = params;
  const secret = await params.env.INTERNAL_API_SECRET_PROD.get();
  const url = new URL(OWNER_POOL_CONVERSION_PATH, params.env.KILO_WEB_API_BASE_URL);
  const results: OwnerPoolConversionResult[] = [];
  let consecutiveFailed = params.previousConsecutiveFailed;
  for (let start = 0; start < conversions.length; start += MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST) {
    const lastPosted = conversions[start - 1];
    if (lastPosted && Date.now() - params.pageStartedAt > PAGE_POST_BUDGET_MS) {
      return {
        results,
        notPosted: [],
        abortReason: null,
        consecutiveFailed,
        stoppedAfter: lastPosted.owner.id,
      };
    }
    const chunk = conversions.slice(start, start + MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST);
    const chunkResults = await postChunk(url, secret, chunk);
    if (chunkResults === null) {
      // The request may still have applied; a retry reports those owners `exists`.
      return {
        results,
        notPosted: conversions.slice(start),
        abortReason: 'batch_failed',
        consecutiveFailed,
        stoppedAfter: null,
      };
    }
    for (const result of chunkResults) {
      if (result.outcome !== 'failed') consecutiveFailed = 0;
      else if (!previouslyFailed.has(result.owner.id)) consecutiveFailed += 1;
    }
    results.push(...chunkResults);
    await onBatch(chunkResults);
    if (consecutiveFailed >= OUTAGE_CONSECUTIVE_FAILURES) {
      return {
        results,
        notPosted: conversions.slice(start + chunk.length),
        abortReason: 'consecutive_failures',
        consecutiveFailed,
        stoppedAfter: null,
      };
    }
  }
  return { results, notPosted: [], abortReason: null, consecutiveFailed, stoppedAfter: null };
}

// Owners the conversion is done with, converted or reported for manual handling; a rerun skips
// them. Only `failed` owners are retried.
const SETTLED_OUTCOMES: ReadonlySet<OwnerPoolConversionOutcome> = new Set([
  'created',
  'exists',
  'owner_not_found',
  'slug_taken',
  'router_cap_reached',
]);

type ReadKind =
  | 'readFailed'
  | 'alreadyConverted'
  | 'invalidPool'
  | 'droppedModeOnly'
  | 'conversion';

export const ownerPoolConversionScanHandler: Handler<HonoEnv> = async c => {
  const pageStartedAt = Date.now();
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = ScanRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid owner pool conversion scan request' }, 400);
  }
  const { ownerType, objectIds, after, limit, dryRun } = parsed.data;
  const namespace = c.env.AUTO_ROUTING_MODE_CONFIG;
  const stubFor = (objectId: string) => namespace.get(namespace.idFromString(objectId));

  const ownerIds = await listOwnerIds(c.env, ownerType, after, limit);
  const matches = matchOwnerObjects(ownerType, ownerIds, new Set(objectIds), name =>
    namespace.idFromName(name).toString()
  );

  const reads = await mapBounded(matches, READ_CONCURRENCY, async match => {
    try {
      const settings: StoredOwnerSettings = await stubFor(match.objectId).readStoredSettings();
      return { match, settings };
    } catch {
      return { match, settings: null };
    }
  });

  const kindByOwner = new Map<string, ReadKind>();
  const invalidModeOwners = new Set<string>();
  const conversions: OwnerPoolConversion[] = [];
  const objectIdByOwner = new Map<string, string>();
  const previouslyFailed = new Set<string>();
  for (const { match, settings } of reads) {
    if (settings === null) {
      kindByOwner.set(match.ownerId, 'readFailed');
      continue;
    }
    if (settings.convertedAt !== null) {
      kindByOwner.set(match.ownerId, 'alreadyConverted');
      continue;
    }
    if (settings.invalidPool) {
      kindByOwner.set(match.ownerId, 'invalidPool');
      continue;
    }
    if (settings.pool === null) {
      kindByOwner.set(match.ownerId, 'droppedModeOnly');
      continue;
    }
    const conversion: OwnerPoolConversion = {
      owner: { type: ownerType, id: match.ownerId },
      mode: settings.mode ?? DEFAULT_AUTO_ROUTING_MODE,
      models: settings.pool.map(entry => entry.model),
    };
    if (
      !CustomRouterEntriesSchema.safeParse(convertedOwnerPoolRouter(conversion).entries).success
    ) {
      kindByOwner.set(match.ownerId, 'invalidPool');
      continue;
    }
    kindByOwner.set(match.ownerId, 'conversion');
    if (settings.invalidMode) invalidModeOwners.add(match.ownerId);
    if (settings.failedAt !== null) previouslyFailed.add(match.ownerId);
    objectIdByOwner.set(match.ownerId, match.objectId);
    conversions.push(conversion);
  }

  const markedAt = new Date().toISOString();
  const markFailedKeys: string[] = [];
  const recordBatch = async (batch: readonly OwnerPoolConversionResult[]) => {
    const lostKeys = await mapBounded(batch, READ_CONCURRENCY, async result => {
      const objectId = objectIdByOwner.get(result.owner.id);
      if (objectId === undefined) return null;
      const stub = stubFor(objectId);
      if (SETTLED_OUTCOMES.has(result.outcome)) {
        try {
          await stub.markConverted(markedAt);
          return null;
        } catch {
          return `${result.owner.type}:${result.owner.id}`;
        }
      }
      // The owner is already reported as `failed`; a lost failure marker only means a retry
      // counts it toward the outage threshold again.
      if (result.outcome === 'failed') await stub.markFailed(markedAt).catch(() => {});
      return null;
    });
    for (const key of lostKeys) if (key !== null) markFailedKeys.push(key);
  };

  const posted =
    dryRun || conversions.length === 0
      ? {
          results: [],
          notPosted: [],
          abortReason: null,
          consecutiveFailed: parsed.data.consecutiveFailed,
          stoppedAfter: null,
        }
      : await postConversions({
          env: c.env,
          conversions,
          pageStartedAt,
          previousConsecutiveFailed: parsed.data.consecutiveFailed,
          previouslyFailed,
          onBatch: recordBatch,
        });
  const { results, abortReason, consecutiveFailed, stoppedAfter } = posted;
  const notPostedKeys = posted.notPosted.map(
    conversion => `${conversion.owner.type}:${conversion.owner.id}`
  );

  // A page that stopped early reports only the owners up to its resume point; the next page
  // lists and counts the rest.
  const lastIndex = stoppedAfter === null ? ownerIds.length - 1 : ownerIds.indexOf(stoppedAfter);
  const inPage = new Set(ownerIds.slice(0, lastIndex + 1));
  const ownersOf = (kind: ReadKind) =>
    [...kindByOwner].filter(([ownerId, k]) => k === kind && inPage.has(ownerId));
  const keysOf = (kind: ReadKind) => ownersOf(kind).map(([ownerId]) => `${ownerType}:${ownerId}`);
  const readFailed = keysOf('readFailed');
  const invalidPool = keysOf('invalidPool');
  const invalidMode = ownersOf('conversion')
    .filter(([ownerId]) => invalidModeOwners.has(ownerId))
    .map(([ownerId]) => `${ownerType}:${ownerId}`);

  const outcomes = Object.fromEntries(
    OwnerPoolConversionOutcomeSchema.options.map(outcome => [outcome, 0])
  ) as Record<OwnerPoolConversionOutcome, number>;
  const attentionOutcomes: ReadonlySet<OwnerPoolConversionOutcome> = new Set(
    OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES
  );
  const needsAttention: string[] = [];
  let noticesSent = 0;
  let noticesFailed = 0;
  for (const result of results) {
    const ownerKey = `${result.owner.type}:${result.owner.id}`;
    outcomes[result.outcome] += 1;
    noticesSent += result.noticesSent;
    noticesFailed += result.noticesFailed;
    if (attentionOutcomes.has(result.outcome)) needsAttention.push(`${result.outcome} ${ownerKey}`);
    if (result.noticesFailed > 0) needsAttention.push(`notice_failed ${ownerKey}`);
  }
  for (const ownerKey of markFailedKeys) needsAttention.push(`mark_failed ${ownerKey}`);

  const aborted = abortReason !== null;
  const summary: OwnerPoolConversionScanResponse = {
    scanned: inPage.size,
    nextCursor: stoppedAfter ?? (ownerIds.length === limit ? (ownerIds.at(-1) ?? null) : null),
    matchedObjectIds: matches
      .filter(match => inPage.has(match.ownerId))
      .map(match => match.objectId),
    alreadyConverted: ownersOf('alreadyConverted').length,
    conversions: ownersOf('conversion').length,
    droppedModeOnly: ownersOf('droppedModeOnly').length,
    readFailed,
    invalidPool,
    invalidMode,
    needsAttention,
    outcomes,
    noticesSent,
    noticesFailed,
    aborted,
    notPosted: notPostedKeys,
    abortReason,
    consecutiveFailed,
  };
  console.log(
    JSON.stringify({
      event: 'auto_routing_owner_pool_conversion_scan',
      ownerType,
      after,
      dryRun,
      aborted,
      abortReason,
      scanned: summary.scanned,
      nextCursor: summary.nextCursor,
      stoppedEarly: stoppedAfter !== null,
      matched: summary.matchedObjectIds.length,
      alreadyConverted: summary.alreadyConverted,
      conversions: summary.conversions,
      droppedModeOnly: summary.droppedModeOnly,
      readFailed: readFailed.length,
      invalidPool: invalidPool.length,
      invalidMode: invalidMode.length,
      needsAttention: needsAttention.length,
      outcomes,
      noticesSent,
      noticesFailed,
      notPosted: notPostedKeys.length,
    })
  );
  return c.json(summary, aborted ? 503 : 200);
};
