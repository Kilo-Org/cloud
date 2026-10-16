import {
  CustomRouterScopeSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST,
  OWNER_POOL_CONVERSION_PATH,
  OwnerPoolConversionOutcomeSchema,
  OwnerPoolConversionResponseSchema,
  type CustomRouterScope,
  type OwnerPoolConversion,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionResult,
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
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    })
  );
  return results;
}

class ConversionPostError extends Error {}

async function postConversions(
  env: Env,
  conversions: readonly OwnerPoolConversion[]
): Promise<OwnerPoolConversionResult[]> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const url = new URL(OWNER_POOL_CONVERSION_PATH, env.KILO_WEB_API_BASE_URL);
  const results: OwnerPoolConversionResult[] = [];
  for (let start = 0; start < conversions.length; start += MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST) {
    const chunk = conversions.slice(start, start + MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST);
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ conversions: chunk }),
    });
    if (!response.ok) {
      throw new ConversionPostError(`owner pool conversion responded ${response.status}`);
    }
    const parsed = OwnerPoolConversionResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success || parsed.data.results.length !== chunk.length) {
      throw new ConversionPostError('owner pool conversion response invalid');
    }
    results.push(...parsed.data.results);
  }
  return results;
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

  const ownerIds = await listOwnerIds(c.env, ownerType, after, limit);
  const matches = matchOwnerObjects(ownerType, ownerIds, new Set(objectIds), name =>
    namespace.idFromName(name).toString()
  );

  const reads = await mapBounded(matches, READ_CONCURRENCY, async match => {
    try {
      const settings: StoredOwnerSettings = await namespace
        .get(namespace.idFromString(match.objectId))
        .readStoredSettings();
      return { match, settings };
    } catch {
      return { match, settings: null };
    }
  });

  const conversions: OwnerPoolConversion[] = [];
  const readFailed: string[] = [];
  let droppedModeOnly = 0;
  for (const { match, settings } of reads) {
    if (settings === null) {
      readFailed.push(`${ownerType}:${match.ownerId}`);
    } else if (settings.pool === null) {
      droppedModeOnly += 1;
    } else {
      conversions.push({
        owner: { type: ownerType, id: match.ownerId },
        mode: settings.mode ?? DEFAULT_AUTO_ROUTING_MODE,
        models: settings.pool.map(entry => entry.model),
      });
    }
  }

  let results: OwnerPoolConversionResult[] = [];
  if (!dryRun && conversions.length > 0) {
    try {
      results = await postConversions(c.env, conversions);
    } catch (error) {
      if (!(error instanceof ConversionPostError)) throw error;
      console.error(
        JSON.stringify({
          event: 'auto_routing_owner_pool_conversion_failed',
          ownerType,
          after,
          error: error.message,
        })
      );
      return c.json({ error: 'Owner pool conversion request failed' }, 500);
    }
  }

  const outcomes = Object.fromEntries(
    OwnerPoolConversionOutcomeSchema.options.map(outcome => [outcome, 0])
  ) as Record<OwnerPoolConversionOutcome, number>;
  let noticesSent = 0;
  let noticesFailed = 0;
  for (const result of results) {
    outcomes[result.outcome] += 1;
    noticesSent += result.noticesSent;
    noticesFailed += result.noticesFailed;
  }

  const summary = {
    scanned: ownerIds.length,
    nextCursor: ownerIds.length === limit ? (ownerIds.at(-1) ?? null) : null,
    matchedObjectIds: matches.map(match => match.objectId),
    conversions: conversions.length,
    droppedModeOnly,
    readFailed,
    outcomes,
    noticesSent,
    noticesFailed,
  };
  console.log(
    JSON.stringify({
      event: 'auto_routing_owner_pool_conversion_scan',
      ownerType,
      after,
      dryRun,
      scanned: summary.scanned,
      nextCursor: summary.nextCursor,
      matched: matches.length,
      conversions: summary.conversions,
      droppedModeOnly,
      readFailed: readFailed.length,
      outcomes,
      noticesSent,
      noticesFailed,
    })
  );
  return c.json(summary);
};
