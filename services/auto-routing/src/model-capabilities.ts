import { formatError, ttlCached } from '@kilocode/worker-utils';
import { getWorkerDb, modelStats } from '@kilocode/db';
import { inArray } from 'drizzle-orm';
import { kvReadThrough, type KvReadThroughMetadata } from './kv-read-through';
import { getRoutingTable } from './routing-table';

// Capability snapshot for a single model. `inputModalities` is the synonym-
// folded set (e.g. an `image_url` row is mapped to `image` so callers do not
// have to know the original vocabulary). `contextLength` is the published
// maximum input tokens, or `null` when the row is missing the column.
// `isActive` is the model_stats soft-active flag; null when unknown/absent.
export type ModelCapabilities = {
  inputModalities: ReadonlySet<string>;
  contextLength: number | null;
  isActive: boolean | null;
};

// An empty Map signals "no capability data" to callers: a request carrying
// `requiredInputModalities` fails closed, a request with only a token
// estimate proceeds unfiltered. A missing key for a specific model id
// carries the same meaning for that model.
export type ModelCapabilitiesMap = ReadonlyMap<string, ModelCapabilities>;

// Modalities the worker actively enforces against `model_stats.input_modalities`.
// Vocabulary evidence: `image` / `image_url` folding mirrors
// `apps/web/src/lib/ai-gateway/providers/model-capabilities.ts:34`; `file` is a
// confirmed OpenRouter `architecture.input_modalities` value (documented enum:
// `text | image | file | audio | video`), and `model_stats.inputModalities` copies
// that field verbatim from the OpenRouter API
// (`apps/web/src/lib/model-stats/sync-openrouter.ts:77,95,124`).
const MODALITY_SYNONYMS: Readonly<Record<string, string>> = {
  image: 'image',
  image_url: 'image',
  file: 'file',
};

function foldModalities(raw: ReadonlyArray<string> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const value of raw) {
    const folded = MODALITY_SYNONYMS[value];
    if (folded !== undefined) {
      out.add(folded);
    }
  }
  return out;
}

// CACHE LAYOUT
//
// `model_capabilities_v2` is a JSON object keyed by `openrouter_id` mapping
// to a `{ inputModalities, contextLength, isActive }` row. Bumped from v1 so
// the first read after deploy repopulates rows including `isActive` (old v1
// rows lack it and would fail custom candidates closed for up to the KV TTL).
// The 1-hour KV TTL means a brand-new routing-table candidate can be
// fail-closed on constrained requests for up to an hour after publication;
// this is accepted as safe because the gateway's balanced fallback remains
// image-capable. The 60s in-memory TTL bounds the same fetch across
// requests within a warm isolate.
//
// The object is the union of every id we have ever resolved, shared by all
// users and all custom pools — capabilities are a property of the model id
// alone (`model_stats.openrouter_id` is unique, and the row is populated from
// OpenRouter's model-level `architecture`), so nothing is user-specific.
// A row with `absent: true` is a tombstone: the id has no `model_stats` row
// (direct BYOK ids never appear in the OpenRouter sync). Without it, such an
// id is missing from the union forever and every request pays a Postgres
// round trip inside the 500ms budget. Tombstones expire with the KV TTL, so
// an id that later gains a row is picked up within the hour.
const MODEL_CAPABILITIES_KV_KEY = 'model_capabilities_v2';
const MODEL_CAPABILITIES_IN_MEMORY_TTL_MS = 60_000;
const MODEL_CAPABILITIES_KV_TTL_SECONDS = 3_600;

// Hard ceiling for the whole lookup (in-memory check + KV read + DB query).
// 500ms leaves headroom inside the gateway's 2s /decide budget when other
// steps are slow; the `statement_timeout: 2_000` on the Postgres side alone
// could otherwise let a slow-failing Hyperdrive connection eat the entire
// request budget.
const MODEL_CAPABILITIES_LOOKUP_BUDGET_MS = 500;

// Keep this in sync with the BytePlus Coding Plan default in
// apps/web/src/lib/ai-gateway/providers/direct-byok/byteplus-coding.ts.
// Direct BYOK models are absent from the OpenRouter model_stats sync, so this
// narrow fallback lets the recognized Coding Plan default satisfy constraints.
const BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID = 'byteplus-coding/bytedance-seed-code';
const BYTEPLUS_CODING_PLAN_DEFAULT_CAPABILITIES: ModelCapabilities = {
  inputModalities: new Set(['image']),
  contextLength: 262_144,
  isActive: true,
};

type ModelCapabilitiesEnv = Pick<
  Env,
  'AUTO_ROUTING_CONFIG' | 'HYPERDRIVE' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'
>;

type ModelCapabilitiesCacheRow = {
  inputModalities: string[];
  contextLength: number | null;
  isActive: boolean | null;
  absent?: boolean;
};

type ModelCapabilitiesCacheValue = Record<string, ModelCapabilitiesCacheRow>;

const TOMBSTONE: ModelCapabilitiesCacheRow = {
  inputModalities: [],
  contextLength: null,
  isActive: null,
  absent: true,
};

function isCacheValue(value: unknown): value is ModelCapabilitiesCacheValue {
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (typeof entry !== 'object' || entry === null) return false;
    const row = entry as {
      inputModalities?: unknown;
      contextLength?: unknown;
      isActive?: unknown;
      absent?: unknown;
    };
    if (!Array.isArray(row.inputModalities)) return false;
    if (row.contextLength !== null && typeof row.contextLength !== 'number') return false;
    // Accept boolean, null, or absent (absent → null on merge).
    if (row.isActive !== undefined && row.isActive !== null && typeof row.isActive !== 'boolean') {
      return false;
    }
    if (row.absent !== undefined && typeof row.absent !== 'boolean') return false;
  }
  return true;
}

async function queryModelCapabilities(
  env: ModelCapabilitiesEnv,
  modelIds: ReadonlyArray<string>
): Promise<ModelCapabilitiesCacheValue> {
  if (modelIds.length === 0) return {};
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const rows = await db
    .select({
      openrouterId: modelStats.openrouterId,
      inputModalities: modelStats.inputModalities,
      contextLength: modelStats.contextLength,
      isActive: modelStats.isActive,
    })
    .from(modelStats)
    .where(inArray(modelStats.openrouterId, modelIds as string[]));
  const out: ModelCapabilitiesCacheValue = {};
  for (const row of rows) {
    if (typeof row.openrouterId !== 'string') continue;
    out[row.openrouterId] = {
      inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities : [],
      contextLength: typeof row.contextLength === 'number' ? row.contextLength : null,
      isActive: typeof row.isActive === 'boolean' ? row.isActive : null,
    };
  }
  return out;
}

const cache = ttlCached<ModelCapabilitiesEnv, ModelCapabilitiesCacheValue>(
  MODEL_CAPABILITIES_IN_MEMORY_TTL_MS,
  async env => loadAll(env)
);

// Tombstones are deliberately NOT merged: callers must see a tombstoned id
// exactly as they see an unknown one (`caps === undefined`), which fails
// required modalities closed and leaves context length unproven.
function mergeInto(
  target: Map<string, ModelCapabilities>,
  source: Readonly<ModelCapabilitiesCacheValue>
): void {
  for (const [modelId, row] of Object.entries(source)) {
    if (row.absent === true) continue;
    target.set(modelId, {
      inputModalities: foldModalities(row.inputModalities),
      contextLength: row.contextLength,
      isActive: row.isActive ?? null,
    });
  }
}

export function clearModelCapabilitiesCache(): void {
  cache.clear();
}

// One-shot load that reads the full cached union of capability rows from
// KV, fills any missing entries from the DB, and returns the whole union
// (as a plain object so it is JSON-serialisable for the in-memory cache).
async function loadAll(env: ModelCapabilitiesEnv): Promise<ModelCapabilitiesCacheValue> {
  const fromKv = await kvReadThrough<ModelCapabilitiesCacheValue>({
    kv: env.AUTO_ROUTING_CONFIG,
    key: MODEL_CAPABILITIES_KV_KEY,
    ttlSeconds: MODEL_CAPABILITIES_KV_TTL_SECONDS,
    fetchOrigin: () => {
      // Cache-miss path: ask the DB for every id we have ever needed.
      // `loadAll` does not know the current id set, so it falls back to
      // scanning the routing table for the canonical id set.
      return queryAllIds(env);
    },
    parse: (raw: string) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isCacheValue(parsed)) {
          console.warn(JSON.stringify({ event: 'kv_model_capabilities_corrupt' }));
          return null;
        }
        // Normalize absent isActive → null so mergeInto is consistent.
        const normalized: ModelCapabilitiesCacheValue = {};
        for (const [id, row] of Object.entries(parsed)) {
          normalized[id] = {
            inputModalities: row.inputModalities,
            contextLength: row.contextLength,
            isActive: row.isActive ?? null,
            ...(row.absent === true ? { absent: true } : {}),
          };
        }
        return normalized;
      } catch (error) {
        console.warn(
          JSON.stringify({ event: 'kv_model_capabilities_corrupt', ...formatError(error) })
        );
        return null;
      }
    },
  });
  return fromKv ?? {};
}

// Ceiling on union size. Pool ids come from user configuration, so without a
// cap a bad config could grow the blob without bound. Past the cap we keep
// serving and stop writing; the KV TTL rebuilds the union from the routing
// table within the hour.
const MODEL_CAPABILITIES_MAX_ENTRIES = 5_000;

// KV rejects a TTL under 60s. Below that the union is about to expire and be
// rebuilt from the routing table anyway, so the write is simply skipped.
const KV_MINIMUM_TTL_SECONDS = 60;

// Publish the filled union so every other isolate, user, and pool reads the
// id from KV instead of Postgres. Concurrent writers are last-write-wins: a
// lost id is re-queried once and written again, so the union converges.
//
// The rewrite holds the ORIGINAL expiry. Resetting the TTL on every fill
// would let a steady trickle of new pool ids keep the blob alive forever,
// and stale rows and tombstones would then never be rebuilt.
async function writeBack(
  env: ModelCapabilitiesEnv,
  merged: ModelCapabilitiesCacheValue
): Promise<void> {
  if (Object.keys(merged).length > MODEL_CAPABILITIES_MAX_ENTRIES) {
    console.warn(JSON.stringify({ event: 'auto_routing_capabilities_union_too_large' }));
    return;
  }
  try {
    const { metadata } =
      await env.AUTO_ROUTING_CONFIG.getWithMetadata<KvReadThroughMetadata>(
        MODEL_CAPABILITIES_KV_KEY
      );
    const writtenAt = typeof metadata?.writtenAt === 'number' ? metadata.writtenAt : Date.now();
    const remainingSeconds = Math.floor(
      (writtenAt + MODEL_CAPABILITIES_KV_TTL_SECONDS * 1_000 - Date.now()) / 1_000
    );
    if (remainingSeconds < KV_MINIMUM_TTL_SECONDS) {
      return;
    }
    await env.AUTO_ROUTING_CONFIG.put(MODEL_CAPABILITIES_KV_KEY, JSON.stringify(merged), {
      expirationTtl: remainingSeconds,
      metadata: { writtenAt } satisfies KvReadThroughMetadata,
    });
    // Drop the in-memory union so this isolate reloads the filled one from KV
    // rather than re-querying the DB for the same ids until its TTL expires.
    cache.clear();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_capabilities_write_back_failed',
        ...formatError(error),
      })
    );
  }
}

async function queryAllIds(env: ModelCapabilitiesEnv): Promise<ModelCapabilitiesCacheValue | null> {
  const routingTable = await getRoutingTable(env);
  if (!routingTable) {
    return null;
  }
  const ids = new Set<string>();
  for (const route of Object.values(routingTable.routes)) {
    for (const candidate of route) {
      ids.add(candidate.model);
    }
  }
  const idList = Array.from(ids);
  return withTombstones(idList, await queryModelCapabilities(env, idList));
}

// Record every id we asked for, so an id with no `model_stats` row is stored
// as resolved-and-absent instead of looking like a cache miss forever.
// Own-key checks throughout: pool ids come from user configuration, and a
// name like `constructor` inherited from Object.prototype would otherwise
// read as already-resolved.
function withTombstones(
  requested: ReadonlyArray<string>,
  rows: Readonly<ModelCapabilitiesCacheValue>
): ModelCapabilitiesCacheValue {
  const out: ModelCapabilitiesCacheValue = { ...rows };
  for (const id of requested) {
    if (!Object.hasOwn(out, id)) {
      out[id] = TOMBSTONE;
    }
  }
  return out;
}

// Look up capability rows for the union of: every model in the published
// routing table, plus the coding-plan default model id when provided, plus
// any additional model ids (custom pool entries). The whole lookup is raced
// against a 500ms budget; on timeout or thrown error the returned Map is
// empty, which the caller treats as "no capability data".
export async function getModelCapabilities(
  env: ModelCapabilitiesEnv,
  options: {
    codingPlanModelId?: string | null;
    additionalModelIds?: ReadonlyArray<string>;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {}
): Promise<ModelCapabilitiesMap> {
  const load = async (): Promise<Map<string, ModelCapabilities>> => {
    // We derive the id set inside the module so the caller (decide.ts) does
    // not have to wait on the routing-table fetch before kicking off the
    // capability lookup. Keeping the fetch inside this closure means the
    // 500ms sub-budget covers the routing-table read as well as the cache/DB
    // lookups. `routing-table.ts`'s `ttlCached` dedups the concurrent in-flight
    // call with whichever other component also asked for the table.
    const routingTable = await getRoutingTable(env);
    const ids = new Set<string>();
    if (routingTable) {
      for (const route of Object.values(routingTable.routes)) {
        for (const candidate of route) {
          ids.add(candidate.model);
        }
      }
    }
    if (options.codingPlanModelId) {
      ids.add(options.codingPlanModelId);
    }
    if (options.additionalModelIds) {
      for (const id of options.additionalModelIds) {
        ids.add(id);
      }
    }
    const idList = Array.from(ids);
    if (idList.length === 0) {
      return new Map();
    }

    const result = new Map<string, ModelCapabilities>();
    const all = await cache.get(env);
    mergeInto(result, all);
    if (
      options.codingPlanModelId === BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID &&
      !result.has(BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID)
    ) {
      result.set(BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID, BYTEPLUS_CODING_PLAN_DEFAULT_CAPABILITIES);
    }
    // The cache stores the union of all ids ever resolved; fill the remainder
    // from the DB and write it back so the next request serves the id from
    // KV. Resolve against the union keys rather than `result` so a tombstoned
    // id counts as resolved and does not re-query.
    // `result.has` keeps the statically-supplied BytePlus default off the DB.
    const missing = idList.filter(id => !Object.hasOwn(all, id) && !result.has(id));
    if (missing.length > 0) {
      const fromDb = await queryModelCapabilities(env, missing);
      mergeInto(result, fromDb);
      // Only publish when the routing table was available. Without it the id
      // set is not the real one, and caching that union would hide the
      // table's own ids for a full KV TTL.
      if (routingTable) {
        const merged: ModelCapabilitiesCacheValue = { ...all, ...withTombstones(missing, fromDb) };
        // Hand the put to waitUntil so it survives the 500ms budget firing
        // and stays off the request's critical path. Without a context
        // (tests) it is awaited, because an unawaited put can be cancelled
        // at request end.
        const written = writeBack(env, merged);
        if (options.waitUntil) {
          options.waitUntil(written);
        } else {
          await written;
        }
      }
    }
    return result;
  };

  try {
    return await raceWithBudget(load(), MODEL_CAPABILITIES_LOOKUP_BUDGET_MS);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_capabilities_lookup_failed',
        ...formatError(error),
      })
    );
    return new Map();
  }
}

// Race a promise against a millisecond budget without leaking the slow
// promise. The eventual rejection of the loser is intentionally swallowed
// so it never surfaces as an unhandled rejection after the budget has
// already fired.
function raceWithBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('capability lookup budget exceeded')), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    // Attach a no-op catch so the losing promise does not surface as an
    // unhandled rejection after the budget has already fired.
    promise.catch(() => {});
  });
}
