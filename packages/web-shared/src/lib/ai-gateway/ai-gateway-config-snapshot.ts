import { ai_gateway_config } from '@kilocode/db/schema';
import { waitUntil } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { AI_GATEWAY_CONFIG_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const MEMORY_TTL_MS = 60_000;
const REDIS_TTL_SECONDS = 300;

/** The raw `ai_gateway_config` columns; each consumer validates its own column. */
export type AiGatewayConfigSnapshot = {
  config: unknown;
  auto_free: unknown;
  unavailable_models: unknown;
  preferred_models: unknown;
};

const AiGatewayConfigSnapshotSchema = z.object({
  config: z.json(),
  auto_free: z.json(),
  unavailable_models: z.json(),
  preferred_models: z.json(),
}) satisfies z.ZodType<AiGatewayConfigSnapshot>;

export async function readAiGatewayConfigSnapshot(
  fromDb: typeof db
): Promise<AiGatewayConfigSnapshot | null> {
  const [row] = await fromDb
    .select({
      config: ai_gateway_config.config,
      auto_free: ai_gateway_config.auto_free,
      unavailable_models: ai_gateway_config.unavailable_models,
      preferred_models: ai_gateway_config.preferred_models,
    })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  return row ?? null;
}

const DELETE_IF_UNCHANGED_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function parseRedisSnapshot(cached: string): AiGatewayConfigSnapshot | null {
  try {
    const parsed = AiGatewayConfigSnapshotSchema.safeParse(JSON.parse(cached));
    if (parsed.success) return parsed.data;
    warnExceptInTest('[ai-gateway-config] ignoring invalid Redis snapshot', parsed.error.message);
  } catch (error) {
    warnExceptInTest('[ai-gateway-config] ignoring unparseable Redis snapshot', error);
  }
  return null;
}

// Removes an invalid value so the NX populate can replace it, without deleting a valid
// snapshot a writer stored after it was read.
async function deleteInvalidRedisSnapshot(invalid: string): Promise<void> {
  try {
    await redisClient.eval(DELETE_IF_UNCHANGED_SCRIPT, [AI_GATEWAY_CONFIG_REDIS_KEY], [invalid]);
  } catch (error) {
    warnExceptInTest('[ai-gateway-config] Redis delete of an invalid snapshot failed', error);
  }
}

async function readRedisSnapshot(): Promise<AiGatewayConfigSnapshot | null> {
  let cached: string | null;
  try {
    cached = await redisClient.get<string>(AI_GATEWAY_CONFIG_REDIS_KEY);
  } catch (error) {
    warnExceptInTest('[ai-gateway-config] Redis read failed', error);
    return null;
  }
  if (cached === null) return null;
  const snapshot = parseRedisSnapshot(cached);
  if (!snapshot) await deleteInvalidRedisSnapshot(cached);
  return snapshot;
}

async function populateRedisSnapshot(snapshot: AiGatewayConfigSnapshot): Promise<void> {
  try {
    // NX: a replica read must never overwrite the value a writer set from the primary.
    await redisClient.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(snapshot), {
      nx: true,
      ex: REDIS_TTL_SECONDS,
    });
  } catch (error) {
    warnExceptInTest('[ai-gateway-config] Redis populate failed', error);
  }
}

async function loadAiGatewayConfigSnapshot(): Promise<AiGatewayConfigSnapshot | null> {
  const cached = await readRedisSnapshot();
  if (cached) return cached;

  const snapshot = await readAiGatewayConfigSnapshot(readDb);
  if (snapshot) waitUntil(populateRedisSnapshot(snapshot));
  return snapshot;
}

/** Null when no config row exists, or when it has never been read successfully. */
export const getAiGatewayConfigSnapshot = createCachedFetch(
  loadAiGatewayConfigSnapshot,
  MEMORY_TTL_MS,
  null
);

/**
 * Derives a value from the cached snapshot, recomputing only when the snapshot changes.
 * When `select` throws on an invalid stored value, the last valid value is kept, or
 * `defaultValue` when there is none.
 */
export function createAiGatewayConfigSelector<T>(
  select: (snapshot: AiGatewayConfigSnapshot) => T,
  defaultValue: T
): () => Promise<T> {
  let source: AiGatewayConfigSnapshot | null | undefined;
  let value = defaultValue;

  return async function get(): Promise<T> {
    const snapshot = await getAiGatewayConfigSnapshot();
    if (snapshot === source) return value;
    source = snapshot;
    if (!snapshot) {
      value = defaultValue;
      return value;
    }
    try {
      value = select(snapshot);
    } catch (error) {
      warnExceptInTest('[ai-gateway-config] keeping the last valid value', error);
    }
    return value;
  };
}

/**
 * Call after committing a write to `ai_gateway_config`. Stores the row read back from the
 * primary, overwriting whatever a reader populated from a possibly lagging replica. If the
 * read-back fails, Redis is left untouched: deleting the key would let a lagging replica
 * repopulate it. If the write fails, the key is deleted so the next reader repopulates; the
 * Redis TTL bounds staleness if that fails too. Never throws.
 */
export async function publishAiGatewayConfigSnapshot(): Promise<void> {
  let snapshot: AiGatewayConfigSnapshot | null;
  try {
    snapshot = await readAiGatewayConfigSnapshot(db);
  } catch (error) {
    console.error('[ai-gateway-config] primary read-back failed; Redis left unchanged', error);
    return;
  }
  if (!snapshot) {
    console.error('[ai-gateway-config] row is missing after a write; Redis left unchanged');
    return;
  }

  try {
    await redisClient.set(AI_GATEWAY_CONFIG_REDIS_KEY, JSON.stringify(snapshot), {
      ex: REDIS_TTL_SECONDS,
    });
  } catch (error) {
    console.error('[ai-gateway-config] Redis publish failed; deleting the cached snapshot', error);
    try {
      await redisClient.del(AI_GATEWAY_CONFIG_REDIS_KEY);
    } catch (deleteError) {
      console.error('[ai-gateway-config] Redis delete failed', deleteError);
    }
  }
}
