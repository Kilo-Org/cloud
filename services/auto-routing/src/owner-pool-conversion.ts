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

const ScanRequestSchema = z.object({
  ownerType: CustomRouterScopeSchema,
  objectIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  after: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(10_000).default(2_000),
  dryRun: z.boolean(),
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

function unpostedResult(conversion: OwnerPoolConversion): OwnerPoolConversionResult {
  return {
    owner: conversion.owner,
    outcome: 'failed',
    modelId: convertedOwnerPoolRouter(conversion).modelId,
    noticesSent: 0,
    noticesFailed: 0,
  };
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
    });
    if (!response.ok) return null;
    const parsed = OwnerPoolConversionResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.results.length === chunk.length
      ? parsed.data.results
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps every result a batch already produced. When the endpoint fails a whole batch (transport
 * error, bad response, or every conversion `failed`), the rest of the page is reported `failed`
 * without being posted, so an outage stops the run instead of failing owner by owner.
 */
async function postConversions(
  env: Env,
  conversions: readonly OwnerPoolConversion[]
): Promise<{ results: OwnerPoolConversionResult[]; aborted: boolean }> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const url = new URL(OWNER_POOL_CONVERSION_PATH, env.KILO_WEB_API_BASE_URL);
  const results: OwnerPoolConversionResult[] = [];
  for (let start = 0; start < conversions.length; start += MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST) {
    const chunk = conversions.slice(start, start + MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST);
    const chunkResults = await postChunk(url, secret, chunk);
    if (chunkResults === null || chunkResults.every(result => result.outcome === 'failed')) {
      results.push(...(chunkResults ?? chunk.map(unpostedResult)));
      results.push(...conversions.slice(start + chunk.length).map(unpostedResult));
      return { results, aborted: true };
    }
    results.push(...chunkResults);
  }
  return { results, aborted: false };
}

export const ownerPoolConversionScanHandler: Handler<HonoEnv> = async c => {
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

  const conversions: OwnerPoolConversion[] = [];
  const objectIdByOwner = new Map<string, string>();
  const readFailed: string[] = [];
  const invalidPool: string[] = [];
  const invalidMode: string[] = [];
  let alreadyConverted = 0;
  let droppedModeOnly = 0;
  for (const { match, settings } of reads) {
    const ownerKey = `${ownerType}:${match.ownerId}`;
    if (settings === null) {
      readFailed.push(ownerKey);
      continue;
    }
    if (settings.convertedAt !== null) {
      alreadyConverted += 1;
      continue;
    }
    if (settings.invalidPool) {
      invalidPool.push(ownerKey);
      continue;
    }
    if (settings.pool === null) {
      droppedModeOnly += 1;
      continue;
    }
    const conversion: OwnerPoolConversion = {
      owner: { type: ownerType, id: match.ownerId },
      mode: settings.mode ?? DEFAULT_AUTO_ROUTING_MODE,
      models: settings.pool.map(entry => entry.model),
    };
    if (!CustomRouterEntriesSchema.safeParse(convertedOwnerPoolRouter(conversion).entries).success) {
      invalidPool.push(ownerKey);
      continue;
    }
    if (settings.invalidMode) invalidMode.push(ownerKey);
    objectIdByOwner.set(match.ownerId, match.objectId);
    conversions.push(conversion);
  }

  const { results, aborted } =
    dryRun || conversions.length === 0
      ? { results: [], aborted: false }
      : await postConversions(c.env, conversions);

  const outcomes = Object.fromEntries(
    OwnerPoolConversionOutcomeSchema.options.map(outcome => [outcome, 0])
  ) as Record<OwnerPoolConversionOutcome, number>;
  const attentionOutcomes: ReadonlySet<OwnerPoolConversionOutcome> = new Set(
    OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES
  );
  const needsAttention: string[] = [];
  const toMark: { ownerKey: string; objectId: string }[] = [];
  let noticesSent = 0;
  let noticesFailed = 0;
  for (const result of results) {
    const ownerKey = `${result.owner.type}:${result.owner.id}`;
    outcomes[result.outcome] += 1;
    noticesSent += result.noticesSent;
    noticesFailed += result.noticesFailed;
    if (attentionOutcomes.has(result.outcome)) needsAttention.push(`${result.outcome} ${ownerKey}`);
    if (result.noticesFailed > 0) needsAttention.push(`notice_failed ${ownerKey}`);
    const objectId = objectIdByOwner.get(result.owner.id);
    if ((result.outcome === 'created' || result.outcome === 'exists') && objectId !== undefined) {
      toMark.push({ ownerKey, objectId });
    }
  }

  const convertedAt = new Date().toISOString();
  const markFailed = await mapBounded(toMark, READ_CONCURRENCY, async ({ ownerKey, objectId }) => {
    try {
      await stubFor(objectId).markConverted(convertedAt);
      return null;
    } catch {
      return ownerKey;
    }
  });
  for (const ownerKey of markFailed) {
    if (ownerKey !== null) needsAttention.push(`mark_failed ${ownerKey}`);
  }

  const summary: OwnerPoolConversionScanResponse = {
    scanned: ownerIds.length,
    nextCursor: ownerIds.length === limit ? (ownerIds.at(-1) ?? null) : null,
    matchedObjectIds: matches.map(match => match.objectId),
    alreadyConverted,
    conversions: conversions.length,
    droppedModeOnly,
    readFailed,
    invalidPool,
    invalidMode,
    needsAttention,
    outcomes,
    noticesSent,
    noticesFailed,
    aborted,
  };
  console.log(
    JSON.stringify({
      event: 'auto_routing_owner_pool_conversion_scan',
      ownerType,
      after,
      dryRun,
      aborted,
      scanned: summary.scanned,
      nextCursor: summary.nextCursor,
      matched: matches.length,
      alreadyConverted,
      conversions: summary.conversions,
      droppedModeOnly,
      readFailed: readFailed.length,
      invalidPool: invalidPool.length,
      invalidMode: invalidMode.length,
      needsAttention: needsAttention.length,
      outcomes,
      noticesSent,
      noticesFailed,
    })
  );
  return c.json(summary, aborted ? 503 : 200);
};
