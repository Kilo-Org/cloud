import { formatError, ttlCached } from '@kilocode/worker-utils';
import { getWorkerDb, modelStats } from '@kilocode/db';
import { inArray } from 'drizzle-orm';
import { kvReadThrough } from './kv-read-through';
import { getRoutingTable } from './routing-table';

// Capability snapshot for a single model. `inputModalities` is the synonym-
// folded set (e.g. an `image_url` row is mapped to `image` so callers do not
// have to know the original vocabulary). `contextLength` is the published
// maximum input tokens, or `null` when the row is missing the column.
export type ModelCapabilities = {
  inputModalities: ReadonlySet<string>;
  contextLength: number | null;
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
// `model_capabilities_v1` is a JSON object keyed by `openrouter_id` mapping
// to a `{ inputModalities: string[], contextLength: number | null }` row.
// The 1-hour KV TTL means a brand-new routing-table candidate can be
// fail-closed on constrained requests for up to an hour after publication;
// this is accepted as safe because the gateway's balanced fallback remains
// image-capable. The 60s in-memory TTL bounds the same fetch across
// requests within a warm isolate.
const MODEL_CAPABILITIES_KV_KEY = 'model_capabilities_v1';
const MODEL_CAPABILITIES_IN_MEMORY_TTL_MS = 60_000;
const MODEL_CAPABILITIES_KV_TTL_SECONDS = 3_600;

// Hard ceiling for the whole lookup (in-memory check + KV read + DB query).
// 500ms leaves headroom inside the gateway's 2s /decide budget when other
// steps are slow; the `statement_timeout: 2_000` on the Postgres side alone
// could otherwise let a slow-failing Hyperdrive connection eat the entire
// request budget.
const MODEL_CAPABILITIES_LOOKUP_BUDGET_MS = 500;

type ModelCapabilitiesEnv = Pick<
  Env,
  'AUTO_ROUTING_CONFIG' | 'HYPERDRIVE' | 'BENCHMARK_SERVICE' | 'INTERNAL_API_SECRET_PROD'
>;

type ModelCapabilitiesCacheValue = Record<
  string,
  { inputModalities: string[]; contextLength: number | null }
>;

function isCacheValue(value: unknown): value is ModelCapabilitiesCacheValue {
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (typeof entry !== 'object' || entry === null) return false;
    const row = entry as { inputModalities?: unknown; contextLength?: unknown };
    if (!Array.isArray(row.inputModalities)) return false;
    if (row.contextLength !== null && typeof row.contextLength !== 'number') return false;
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
    })
    .from(modelStats)
    .where(inArray(modelStats.openrouterId, modelIds as string[]));
  const out: ModelCapabilitiesCacheValue = {};
  for (const row of rows) {
    if (typeof row.openrouterId !== 'string') continue;
    out[row.openrouterId] = {
      inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities : [],
      contextLength: typeof row.contextLength === 'number' ? row.contextLength : null,
    };
  }
  return out;
}

const cache = ttlCached<ModelCapabilitiesEnv, ModelCapabilitiesCacheValue>(
  MODEL_CAPABILITIES_IN_MEMORY_TTL_MS,
  async env => loadAll(env)
);

function mergeInto(
  target: Map<string, ModelCapabilities>,
  source: Readonly<ModelCapabilitiesCacheValue>
): void {
  for (const [modelId, row] of Object.entries(source)) {
    target.set(modelId, {
      inputModalities: foldModalities(row.inputModalities),
      contextLength: row.contextLength,
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
        return parsed;
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
  return queryModelCapabilities(env, Array.from(ids));
}

// Look up capability rows for the union of: every model in the published
// routing table, plus the coding-plan default model id when provided. The
// whole lookup (routing-table fetch + id derivation + in-memory check + KV
// read + DB query) is raced against a 500ms budget; on timeout or thrown
// error the returned Map is empty, which the caller treats as "no capability
// data".
export async function getModelCapabilities(
  env: ModelCapabilitiesEnv,
  options: { codingPlanModelId?: string | null } = {}
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
    const idList = Array.from(ids);
    if (idList.length === 0) {
      return new Map();
    }

    const result = new Map<string, ModelCapabilities>();
    const all = await cache.get(env);
    mergeInto(result, all);
    // The cache stores the union of all ids ever requested; fill the
    // remainder from the DB. We don't write the partial-fill back to KV —
    // a true cache miss above already wrote the full union, and a partial
    // hit is rare enough that the extra round-trip is acceptable.
    const missing = idList.filter(id => !result.has(id));
    if (missing.length > 0) {
      const fromDb = await queryModelCapabilities(env, missing);
      mergeInto(result, fromDb);
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
