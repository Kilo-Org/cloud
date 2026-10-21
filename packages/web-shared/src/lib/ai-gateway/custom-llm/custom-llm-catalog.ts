import 'server-only';
import { custom_llm2, type CustomLlm2 } from '@kilocode/db/schema';
import { CustomLlmDefinitionSchema, type CustomLlmDefinition } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { captureException } from '@sentry/nextjs';

export type CustomLlm = {
  public_id: string;
  definition: CustomLlmDefinition;
  encrypted_api_key: CustomLlm2['encrypted_api_key'];
};

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

/** Admin edits take effect when this expires: every serverless instance keeps
 * its own copy, so there is no cross-instance invalidation. Routing reads this
 * on every gateway request, so it must not hit the database each time. */
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

async function loadCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  try {
    const byId = new Map<string, CustomLlm>();
    for (const customLlm of await fetchCustomLlmsFromDatabase()) {
      byId.set(customLlm.public_id.toLowerCase(), customLlm);
    }
    cache = { byId, at: Date.now() };
    lastFailureAt = null;
    return byId;
  } catch (error) {
    lastFailureAt = Date.now();
    console.error('Failed to load custom LLMs', error);
    captureException(error, { tags: { source: 'custom_llm_catalog' } });
    throw error;
  }
}

/** A failed refresh serves the previous value; with nothing cached the catalog is unavailable. */
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

/**
 * All valid custom LLMs keyed by lowercased public id. Empty while the catalog
 * is unavailable, which treats every id as a built-in model; code that must not
 * expose a custom LLM by mistake uses `requireCustomLlmsById` instead.
 */
export async function getCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  return (await getCustomLlmCatalog()).byId;
}

export class CustomLlmCatalogUnavailableError extends Error {
  constructor() {
    super('The custom LLM catalog could not be read');
    this.name = 'CustomLlmCatalogUnavailableError';
  }
}

/** Like `getCustomLlmsById`, but throws instead of returning an empty map while unavailable. */
export async function requireCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  const catalog = await getCustomLlmCatalog();
  if (!catalog.available) throw new CustomLlmCatalogUnavailableError();
  return catalog.byId;
}

/** Tests insert rows directly; production relies on `CACHE_TTL_MS` expiry. */
export function resetCustomLlmCacheForTest() {
  cache = null;
  inFlight = null;
  lastFailureAt = null;
}

export async function findCustomLlm(modelId: string): Promise<CustomLlm | null> {
  return (await getCustomLlmsById()).get(modelId.trim().toLowerCase()) ?? null;
}

export async function isCustomLlm(modelId: string): Promise<boolean> {
  return (await findCustomLlm(modelId)) !== null;
}
