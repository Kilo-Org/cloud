import 'server-only';
import { custom_llm2, type CustomLlm2 } from '@kilocode/db/schema';
import { CustomLlmDefinitionSchema, type CustomLlmDefinition } from '@kilocode/db/schema-types';
import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
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

export type PartnerCustomLlmDefinition = CustomLlmDefinition & {
  partner: NonNullable<CustomLlmDefinition['partner']>;
  pricing: NonNullable<CustomLlmDefinition['pricing']>;
};

export type PartnerCustomLlm = Omit<CustomLlm, 'definition'> & {
  definition: PartnerCustomLlmDefinition;
};

/** A partner serves a catalog model instead of owning its id; see `CustomLlmPartnerSchema`. */
export function isPartnerCustomLlm(customLlm: CustomLlm): customLlm is PartnerCustomLlm {
  return customLlm.definition.partner !== undefined && customLlm.definition.pricing !== undefined;
}

/**
 * A row that fails the definition schema is dropped from the catalog, which
 * removes an admin-configured model, so it reports through the same channel as a
 * failed read: an error log every time, and a Sentry event at most once per row
 * per report window, because the catalog refreshes every minute and a stored
 * definition does not fix itself.
 */
function reportUnparseableCustomLlm(publicId: string, error: unknown): void {
  console.error('Failed to parse custom llm definition', publicId, error);
  // The claim map is shared with other reports, whose keys are row ids, so the key
  // is namespaced (public ids cannot contain `:`).
  if (!claimReportWindow(`custom-llm:${publicId}`, Date.now())) return;
  captureException(error, {
    tags: { source: 'custom_llm_catalog' },
    extra: { public_id: publicId },
  });
}

function parseAllCustomLlmRows(rows: readonly CustomLlm2[]): CustomLlm[] {
  return rows.flatMap(row => {
    const parsed = CustomLlmDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      reportUnparseableCustomLlm(row.public_id, parsed.error);
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

/** The custom LLMs that own their id, without partners. */
export function parseCustomLlmRows(rows: readonly CustomLlm2[]): CustomLlm[] {
  return parseAllCustomLlmRows(rows).filter(customLlm => !isPartnerCustomLlm(customLlm));
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

type CustomLlmMaps = {
  byId: ReadonlyMap<string, CustomLlm>;
  partnersById: ReadonlyMap<string, PartnerCustomLlm>;
};

type CustomLlmCatalog = CustomLlmMaps & {
  /** False when the catalog could not be read and nothing was cached before. */
  available: boolean;
};

const UNAVAILABLE_CATALOG: CustomLlmCatalog = {
  byId: new Map(),
  partnersById: new Map(),
  available: false,
};

let cache: (CustomLlmMaps & { at: number }) | null = null;
let inFlight: Promise<CustomLlmMaps> | null = null;
let lastFailureAt: number | null = null;

async function loadCustomLlmsById(): Promise<CustomLlmMaps> {
  try {
    const byId = new Map<string, CustomLlm>();
    const partnersById = new Map<string, PartnerCustomLlm>();
    for (const customLlm of parseAllCustomLlmRows(await readDb.select().from(custom_llm2))) {
      const key = customLlm.public_id.toLowerCase();
      if (isPartnerCustomLlm(customLlm)) partnersById.set(key, customLlm);
      else byId.set(key, customLlm);
    }
    cache = { byId, partnersById, at: Date.now() };
    lastFailureAt = null;
    return { byId, partnersById };
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
    return { ...cache, available: true };
  }
  if (lastFailureAt !== null && Date.now() - lastFailureAt < FAILURE_RETRY_MS) {
    return cache ? { ...cache, available: true } : UNAVAILABLE_CATALOG;
  }
  if (!inFlight) {
    const load = loadCustomLlmsById().finally(() => {
      if (inFlight === load) inFlight = null;
    });
    inFlight = load;
  }
  try {
    return { ...(await inFlight), available: true };
  } catch {
    return cache ? { ...cache, available: true } : UNAVAILABLE_CATALOG;
  }
}

/**
 * All valid custom LLMs that own their id, keyed by lowercased public id. Partners
 * are excluded, since their id stays a catalog model (see `findPartnerCustomLlm`).
 * Empty while the catalog is unavailable, which treats every id as a built-in
 * model; code that must not expose a custom LLM by mistake uses
 * `requireCustomLlmsById` instead.
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

/** A custom LLM for the id, or null when there is none or the catalog is unavailable. */
export async function findCustomLlm(modelId: string): Promise<CustomLlm | null> {
  return (await getCustomLlmsById()).get(modelId.trim().toLowerCase()) ?? null;
}

/** The partner for the catalog model id, or null when there is none or the catalog is unavailable. */
export async function findPartnerCustomLlm(modelId: string): Promise<PartnerCustomLlm | null> {
  return (await getCustomLlmCatalog()).partnersById.get(modelId.trim().toLowerCase()) ?? null;
}

export async function isCustomLlm(modelId: string): Promise<boolean> {
  return (await findCustomLlm(modelId)) !== null;
}

/** The inference providers a public custom LLM declares, or null for any other id. */
export async function getPublicCustomLlmInferenceProviders(
  modelId: string
): Promise<ReadonlySet<string> | null> {
  const customLlm = await findCustomLlm(modelId);
  if (!customLlm || !isPublicCustomLlm(customLlm.definition)) return null;
  return new Set(customLlm.definition.public.inference_providers);
}
