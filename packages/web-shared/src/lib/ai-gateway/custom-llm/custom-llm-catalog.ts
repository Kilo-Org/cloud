import 'server-only';
import { custom_llm2, type CustomLlm2 } from '@kilocode/db/schema';
import { CustomLlmDefinitionSchema, type CustomLlmDefinition } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';

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

let cache: { byId: ReadonlyMap<string, CustomLlm>; at: number } | null = null;
let inFlight: Promise<ReadonlyMap<string, CustomLlm>> | null = null;

async function loadCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  const byId = new Map<string, CustomLlm>();
  for (const customLlm of await fetchCustomLlmsFromDatabase()) {
    byId.set(customLlm.public_id.toLowerCase(), customLlm);
  }
  cache = { byId, at: Date.now() };
  return byId;
}

/**
 * All valid custom LLMs keyed by lowercased public id. A failed refresh serves
 * the previous value; with nothing cached it throws, because silently treating
 * a custom LLM id as unknown would route it to another upstream.
 */
export async function getCustomLlmsById(): Promise<ReadonlyMap<string, CustomLlm>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.byId;
  }
  inFlight ??= loadCustomLlmsById().finally(() => {
    inFlight = null;
  });
  try {
    return await inFlight;
  } catch (error) {
    if (cache) return cache.byId;
    throw error;
  }
}

/** Drops this instance's cache so admin edits apply here immediately. */
export function invalidateCustomLlmCache() {
  cache = null;
}

export async function findCustomLlm(modelId: string): Promise<CustomLlm | null> {
  return (await getCustomLlmsById()).get(modelId.trim().toLowerCase()) ?? null;
}

export async function getPublicCustomLlms(): Promise<
  Array<CustomLlm & { definition: PublicCustomLlmDefinition }>
> {
  return [...(await getCustomLlmsById()).values()].flatMap(customLlm => {
    const { definition } = customLlm;
    return isPublicCustomLlm(definition) ? [{ ...customLlm, definition }] : [];
  });
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
