import 'server-only';
import { custom_llm2, type CustomLlm2 } from '@kilocode/db/schema';
import { CustomLlmDefinitionSchema, type CustomLlmDefinition } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { captureException } from '@sentry/nextjs';

export type CustomLlm = {
  public_id: string;
  definition: CustomLlmDefinition;
  encrypted_api_key: CustomLlm2['encrypted_api_key'];
};

export type PublicCustomLlmDefinition = CustomLlmDefinition & {
  public: NonNullable<CustomLlmDefinition['public']>;
};

export function isPublicCustomLlm(
  definition: CustomLlmDefinition
): definition is PublicCustomLlmDefinition {
  return definition.public !== undefined;
}

export function parseCustomLlmRows(rows: readonly CustomLlm2[]): CustomLlm[] {
  return rows.flatMap(row => {
    const parsed = CustomLlmDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      console.log('Failed to parse custom llm definition', row.public_id, parsed.error);
      return [];
    }
    return [
      {
        public_id: row.public_id,
        definition: parsed.data,
        encrypted_api_key: row.encrypted_api_key,
      },
    ];
  });
}

export async function fetchCustomLlmsFromDatabase(): Promise<CustomLlm[]> {
  return parseCustomLlmRows(await readDb.select().from(custom_llm2));
}

/** Short enough that admin edits reach every instance quickly; routing reads
 * this on every gateway request, so it must not hit the database each time. */
const CACHE_TTL_MS = 60_000;
/** After a failed read, wait this long before querying again so an outage does
 * not turn every lookup into a database query and a Sentry event. */
const FAILURE_RETRY_MS = 5_000;

type CustomLlmCatalog = {
  byId: ReadonlyMap<string, CustomLlm>;
  /** False when the catalog could not be read and nothing was cached before. */
  available: boolean;
};

const UNAVAILABLE_CATALOG: CustomLlmCatalog = { byId: new Map(), available: false };

let cache: { byId: ReadonlyMap<string, CustomLlm>; at: number } | null = null;
let inFlight: Promise<ReadonlyMap<string, CustomLlm>> | null = null;
let lastFailureAt: number | null = null;
/** Bumped on invalidation so a load that started earlier cannot update the cache. */
let generation = 0;

async function loadCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  const loadGeneration = generation;
  try {
    const byId = new Map<string, CustomLlm>();
    for (const customLlm of await fetchCustomLlmsFromDatabase()) {
      byId.set(customLlm.public_id.toLowerCase(), customLlm);
    }
    if (loadGeneration === generation) {
      cache = { byId, at: Date.now() };
      lastFailureAt = null;
    }
    return byId;
  } catch (error) {
    if (loadGeneration === generation) lastFailureAt = Date.now();
    console.error('Failed to load custom LLMs', error);
    captureException(error, { tags: { source: 'custom_llm_catalog' } });
    throw error;
  }
}

/**
 * A failed refresh serves the previous value. With nothing cached the catalog
 * is unavailable; see `lookupCustomLlm` for how callers treat that.
 */
async function getCustomLlmCatalog(): Promise<CustomLlmCatalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { byId: cache.byId, available: true };
  }
  if (lastFailureAt !== null && Date.now() - lastFailureAt < FAILURE_RETRY_MS) {
    return cache ? { byId: cache.byId, available: true } : UNAVAILABLE_CATALOG;
  }
  if (!inFlight) {
    const load = loadCustomLlmsById().finally(() => {
      if (inFlight === load) inFlight = null;
    });
    inFlight = load;
  }
  try {
    return { byId: await inFlight, available: true };
  } catch {
    return cache ? { byId: cache.byId, available: true } : UNAVAILABLE_CATALOG;
  }
}

/** All valid custom LLMs keyed by lowercased public id; empty while unavailable. */
export async function getCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  return (await getCustomLlmCatalog()).byId;
}

/** Drops this instance's cache so admin edits apply here immediately. */
export function invalidateCustomLlmCache() {
  generation++;
  cache = null;
  inFlight = null;
  lastFailureAt = null;
}

export type CustomLlmLookup =
  | { kind: 'custom-llm'; customLlm: CustomLlm }
  | { kind: 'none' }
  | { kind: 'unknown' };

/**
 * Resolves a model id for routing. While the catalog is unavailable, an id is
 * `unknown` only if it is a Kilo-exclusive id: a custom LLM may shadow it, and
 * routing must not fall back to the exclusive model. Any other custom LLM id
 * matches no built-in model, so treating it as built-in fails on its own.
 */
export async function lookupCustomLlm(modelId: string): Promise<CustomLlmLookup> {
  const normalizedModelId = modelId.trim().toLowerCase();
  const catalog = await getCustomLlmCatalog();
  const customLlm = catalog.byId.get(normalizedModelId);
  if (customLlm) return { kind: 'custom-llm', customLlm };
  if (
    !catalog.available &&
    kiloExclusiveModels.some(model => model.public_id === normalizedModelId)
  ) {
    return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

/** A custom LLM for the id, or null when there is none or the catalog is unavailable. */
export async function findCustomLlm(modelId: string): Promise<CustomLlm | null> {
  return (await getCustomLlmsById()).get(modelId.trim().toLowerCase()) ?? null;
}

/**
 * `isFreeModel` that also knows custom LLMs. A custom LLM shadows any built-in
 * model with the same id, so its own public flag decides.
 */
export async function isFreeModelIncludingCustomLlms(modelId: string): Promise<boolean> {
  const customLlm = await findCustomLlm(modelId);
  return customLlm ? isPublicCustomLlm(customLlm.definition) : isFreeModel(modelId);
}

/**
 * Inference providers a model id is restricted to by a public custom LLM, or
 * null when the id is not a public custom LLM.
 */
export async function getPublicCustomLlmInferenceProviders(
  modelId: string
): Promise<ReadonlySet<string> | null> {
  const customLlm = await findCustomLlm(modelId);
  return customLlm && isPublicCustomLlm(customLlm.definition)
    ? new Set(customLlm.definition.public.inference_providers)
    : null;
}
