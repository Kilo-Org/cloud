import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, gt, lte, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sanitizedExceptionName } from '@kilocode/worker-utils/scheduled-job-observability';
import { kilocode_users } from '@kilocode/db';
import { getPostgresErrorCode } from '@/lib/db-errors';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY,
  SAFETY_IDENTIFIER_BACKFILL_STATE_KEY,
} from '@kilocode/web-shared/lib/redis-keys';

export const SAFETY_IDENTIFIER_BATCH_SIZE = 5_000;
export const SAFETY_IDENTIFIER_SCHEDULE_MINUTES = 3;
export const SAFETY_IDENTIFIER_WORK_BUDGET_MS = 240_000;
export const SAFETY_IDENTIFIER_BACKFILL_ERROR =
  'Safety identifier regeneration failed. Retry to resume.';
const SQL_CHUNK_SIZE = 1_000;
const LOCK_SECONDS = 360;

const progressSchema = z.object({
  status: z.enum(['pending', 'running', 'completed']),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  cursor: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  lastBatchProcessed: z.number().int().min(0).max(SAFETY_IDENTIFIER_BATCH_SIZE),
  lastError: z.string().nullable(),
});

const stateSchema = progressSchema
  .extend({
    version: z.literal(1),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    highWaterId: z.string().nullable(),
    status: z.enum(['running', 'completed']),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine(state => (state.status === 'completed') === (state.completedAt !== null));

export type SafetyIdentifierBackfillProgress = z.infer<typeof progressSchema>;
type BackfillState = z.infer<typeof stateSchema>;

const pendingProgress: SafetyIdentifierBackfillProgress = {
  status: 'pending',
  processed: 0,
  total: null,
  cursor: null,
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  lastBatchProcessed: 0,
  lastError: null,
};

const checkpointScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const releaseScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

async function readState(): Promise<BackfillState | null> {
  const value = await redisClient.get<string>(SAFETY_IDENTIFIER_BACKFILL_STATE_KEY);
  return value === null ? null : stateSchema.parse(JSON.parse(value));
}

export async function getSafetyIdentifierStatus() {
  const state = await readState();
  const lock = await redisClient.get<string>(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY);
  return {
    backfill: state ? progressSchema.parse(state) : pendingProgress,
    running: lock !== null,
    batchSize: SAFETY_IDENTIFIER_BATCH_SIZE,
    scheduleMinutes: SAFETY_IDENTIFIER_SCHEDULE_MINUTES,
  };
}

export async function regenerateSafetyIdentifiers({ deadlineAt }: { deadlineAt: number }) {
  if (!getEnvVariable('OPENROUTER_ORG_ID')) {
    throw new Error('OPENROUTER_ORG_ID is not configured on this server');
  }
  const probeId = 'safety-identifier-regeneration-fingerprint';
  const targetFingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        1,
        generateOpenRouterUpstreamSafetyIdentifier(probeId),
        generateOpenRouterDownstreamSafetyIdentifier(probeId),
        generateVercelDownstreamSafetyIdentifier(probeId),
      ])
    )
    .digest('hex');
  const owner = randomUUID();
  const admitted = await redisClient.set(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY, owner, {
    nx: true,
    ex: LOCK_SECONDS,
  });
  if (admitted === null) return { processed: 0, remaining: true, skipped: true };
  if (admitted !== 'OK') throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR);

  let state: BackfillState | null = null;
  let processed = 0;
  const checkpoint = async (next: BackfillState) => {
    const saved = await redisClient.eval(
      checkpointScript,
      [SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY, SAFETY_IDENTIFIER_BACKFILL_STATE_KEY],
      [owner, JSON.stringify(next)]
    );
    if (saved !== 1) throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR);
    state = next;
  };

  try {
    const stored = await readState();
    state = stored;
    if (stored && stored.targetFingerprint !== targetFingerprint) {
      if (stored.status !== 'completed') throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR);
      state = null;
    }
    if (state?.status === 'completed') {
      return { processed: 0, remaining: false, skipped: false };
    }
    if (!state) {
      const [snapshot] = await db
        .select({ total: count(), highWaterId: max(kilocode_users.id) })
        .from(kilocode_users);
      const now = new Date().toISOString();
      state = {
        ...pendingProgress,
        version: 1,
        targetFingerprint,
        highWaterId: snapshot?.highWaterId ?? null,
        total: snapshot?.total ?? 0,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      };
      await checkpoint(state);
    }

    while (processed < SAFETY_IDENTIFIER_BATCH_SIZE && Date.now() < deadlineAt) {
      const rows =
        state.highWaterId === null
          ? []
          : await db
              .select({ id: kilocode_users.id })
              .from(kilocode_users)
              .where(
                and(
                  lte(kilocode_users.id, state.highWaterId),
                  state.cursor === null ? undefined : gt(kilocode_users.id, state.cursor)
                )
              )
              .orderBy(asc(kilocode_users.id))
              .limit(SQL_CHUNK_SIZE);

      if (Date.now() >= deadlineAt) break;
      if ((await redisClient.get<string>(SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY)) !== owner) {
        throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR);
      }
      if (rows.length > 0) {
        const updates = rows.map(({ id }) => {
          const upstream = generateOpenRouterUpstreamSafetyIdentifier(id);
          if (upstream === null) throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR);
          return sql`(${id}, ${upstream}, ${generateOpenRouterDownstreamSafetyIdentifier(id)}, ${generateVercelDownstreamSafetyIdentifier(id)})`;
        });
        // Raw SQL intentionally preserves updated_at; each statement commits before its checkpoint.
        await db.execute(sql`
          UPDATE ${kilocode_users}
          SET openrouter_upstream_safety_identifier = updates.upstream,
              openrouter_downstream_safety_identifier = updates.downstream,
              vercel_downstream_safety_identifier = updates.vercel
          FROM (VALUES ${sql.join(updates, sql`, `)}) AS updates(id, upstream, downstream, vercel)
          WHERE ${kilocode_users.id} = updates.id
        `);
      }
      const last = rows.at(-1);
      const completed = rows.length < SQL_CHUNK_SIZE || last?.id === state.highWaterId;
      const now = new Date().toISOString();
      const next: BackfillState = {
        ...state,
        status: completed ? 'completed' : 'running',
        cursor: last?.id ?? state.cursor,
        processed: state.processed + rows.length,
        lastBatchProcessed: processed + rows.length,
        updatedAt: now,
        completedAt: completed ? now : null,
        lastError: null,
      };
      await checkpoint(next);
      processed += rows.length;
      if (completed) break;
    }
    return { processed, remaining: state.status !== 'completed', skipped: false };
  } catch (error) {
    console.error('Safety identifier regeneration failed', {
      exception_name: sanitizedExceptionName(error),
      database_error_code: getPostgresErrorCode(error),
    });
    if (state) {
      try {
        await checkpoint({
          ...state,
          updatedAt: new Date().toISOString(),
          lastBatchProcessed: processed,
          lastError: SAFETY_IDENTIFIER_BACKFILL_ERROR,
        });
      } catch {
        // An unavailable Redis or a replacement owner must leave the previous checkpoint untouched.
      }
    }
    throw new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR, { cause: error });
  } finally {
    try {
      await redisClient.eval(releaseScript, [SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY], [owner]);
    } catch {
      console.warn('Safety identifier regeneration lock release failed; waiting for lock expiry.');
    }
  }
}
