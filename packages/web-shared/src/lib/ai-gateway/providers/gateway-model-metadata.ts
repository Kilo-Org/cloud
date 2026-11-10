import { sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import {
  EndpointPricingSchema,
  EndpointSchema,
  EndpointsSchema,
  ModelArchitectureSchema,
  ModelSchema,
  ModelsSchema,
  type Endpoint,
  type GatewayModel,
} from '@kilocode/db/schema-types';
import {
  assertMinimumCount,
  type MetadataDb,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export type GatewayModelWithEndpoints = GatewayModel & { endpoints: Endpoint[] };

export type GatewayModelMap = Record<string, GatewayModelWithEndpoints>;

export const NO_ENDPOINTS_RESOURCE = 'no-endpoints-resource';
const NoEndpointsResourceSchema = z.strictObject({ status: z.literal(404) });

export type GatewayModelList = z.infer<typeof ModelsSchema>;
export type GatewayModelEndpoints = Endpoint[] | typeof NO_ENDPOINTS_RESOURCE;

const MINIMUM_GATEWAY_MODEL_COUNT = 100;
const LOGGED_MODEL_ID_LIMIT = 20;

function gatewayHeaders(gateway: Provider) {
  return {
    ...ATTRIBUTION_HEADERS,
    authorization: `Bearer ${gateway.apiKey}`,
  };
}

export function gatewayModelsSource(
  gateway: Provider,
  modelsPath: string
): MetadataSource<GatewayModelList> {
  const url = `${gateway.apiUrl}${modelsPath}`;
  return {
    url,
    headers: () => gatewayHeaders(gateway),
    parse: raw => {
      const models = ModelsSchema.parse(raw);
      assertMinimumCount(url, models.data.length, MINIMUM_GATEWAY_MODEL_COUNT);
      return models;
    },
  };
}

// The default OpenRouter list only has text-output models; System One models output decisions.
export const openRouterGatewayModelsSource = gatewayModelsSource(
  OPENROUTER,
  '/models?output_modalities=all'
);
export const vercelGatewayModelsSource = gatewayModelsSource(VERCEL_AI_GATEWAY, '/models');

function gatewayModelEndpointsUrlPrefix(gateway: Provider) {
  return `${gateway.apiUrl}/models/`;
}

const GATEWAY_MODEL_ENDPOINTS_URL_SUFFIX = '/endpoints';

export function gatewayModelEndpointsUrl(gateway: Provider, modelId: string) {
  return `${gatewayModelEndpointsUrlPrefix(gateway)}${modelId}${GATEWAY_MODEL_ENDPOINTS_URL_SUFFIX}`;
}

function parseGatewayModelEndpoints(raw: unknown): GatewayModelEndpoints {
  return NoEndpointsResourceSchema.safeParse(raw).success
    ? NO_ENDPOINTS_RESOURCE
    : EndpointsSchema.parse(raw).data.endpoints;
}

export function gatewayModelEndpointsSource(
  gateway: Provider,
  modelId: string
): MetadataSource<GatewayModelEndpoints> {
  return {
    url: gatewayModelEndpointsUrl(gateway, modelId),
    headers: () => gatewayHeaders(gateway),
    // Gateways list some models (e.g. Vercel's `*-batch` variants) that have no endpoints resource.
    // Storing the 404 as a row keeps sync-providers from fetching those models live on every run.
    rawWhenNotFound: { status: 404 } satisfies z.infer<typeof NoEndpointsResourceSchema>,
    parse: parseGatewayModelEndpoints,
  };
}

/**
 * Keeps only `keys` of a jsonb object, so the query returns about as much data as the parsed models
 * hold rather than the raw upstream bodies. Absent keys stay absent, null values stay null, and
 * non-object values pass through unchanged, so the schemas see what they would in the raw body.
 */
function pickJsonbKeys(
  value: SQL,
  keys: readonly string[],
  nested: Partial<Record<string, readonly string[]>> = {}
): SQL {
  const object = sql`(${value})`;
  const otherKeys = sql`(
    SELECT coalesce(array_agg(key), '{}'::text[]) FROM jsonb_object_keys(${object}) AS key
    WHERE key NOT IN ${keys}
  )`;
  const nestedPicks = Object.entries(nested).map(([key, nestedKeys = []]) => {
    const member = sql`${object}->${key}::text`;
    return sql` || CASE WHEN ${object} ? ${key}::text
      THEN jsonb_build_object(${key}::text, ${pickJsonbKeys(member, nestedKeys)})
      ELSE '{}'::jsonb END`;
  });
  return sql`CASE WHEN jsonb_typeof(${object}) = 'object'
    THEN (${object} - ${otherKeys})${sql.join(nestedPicks, sql``)}
    ELSE ${object} END`;
}

function jsonbArrayOrEmpty(value: SQL) {
  return sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;
}

/** `endpoints` is undefined when the model's endpoints row is missing or unusable. */
export type ListedGatewayModel = {
  model: GatewayModel;
  endpoints: GatewayModelEndpoints | undefined;
};

export function formatModelIds(modelIds: readonly string[]) {
  const listed = modelIds.slice(0, LOGGED_MODEL_ID_LIMIT).join(', ');
  return modelIds.length > LOGGED_MODEL_ID_LIMIT
    ? `${listed} and ${modelIds.length - LOGGED_MODEL_ID_LIMIT} more`
    : listed;
}

function parseStoredGatewayModelEndpoints(raw: unknown): GatewayModelEndpoints | undefined {
  if (raw === null) return undefined;
  try {
    return parseGatewayModelEndpoints(raw);
  } catch {
    return undefined;
  }
}

/**
 * Reads a stored gateway model list and the stored endpoints of every listed model in one query,
 * in list order. Returns null when the list is not stored. Throws when the query fails or the list
 * fails `source.parse`, including its truncation check, so a cached caller keeps its last good
 * value.
 */
export async function readStoredGatewayModels(
  gateway: Provider,
  source: MetadataSource<GatewayModelList>,
  fromDb: MetadataDb
): Promise<ListedGatewayModel[] | null> {
  const item = sql`items.item`;
  const endpointsData = sql`endpoints_row.data`;
  const endpointsList = sql`${endpointsData}->'data'->'endpoints'`;
  // Both aggregates run over the same rows in the same order, so `endpoints[i]` belongs to the
  // `i`th listed model, and JSON null stands for a missing endpoints row.
  const result = await fromDb.execute<{ models: unknown; endpoints: unknown[] }>(sql`
    SELECT
      CASE WHEN jsonb_typeof(list.data->'data') = 'array'
        THEN jsonb_build_object('data', coalesce(projected.models, '[]'::jsonb))
        ELSE list.data
      END AS models,
      coalesce(projected.endpoints, '[]'::jsonb) AS endpoints
    FROM ai_gateway_metadata_cache AS list
    CROSS JOIN LATERAL (
      SELECT
        jsonb_agg(
          ${pickJsonbKeys(item, ModelSchema.keyof().options, {
            architecture: ModelArchitectureSchema.keyof().options,
          })}
          ORDER BY items.ordinality
        ) AS models,
        jsonb_agg(
          CASE WHEN jsonb_typeof(${endpointsList}) = 'array'
            THEN jsonb_build_object('data', jsonb_build_object('endpoints', (
              SELECT coalesce(jsonb_agg(
                ${pickJsonbKeys(sql`endpoints.endpoint`, EndpointSchema.keyof().options, {
                  pricing: EndpointPricingSchema.keyof().options,
                })}
                ORDER BY endpoints.ordinality
              ), '[]'::jsonb)
              FROM jsonb_array_elements(${endpointsList}) WITH ORDINALITY AS endpoints(endpoint, ordinality)
            )))
            ELSE coalesce(${endpointsData}, 'null'::jsonb)
          END
          ORDER BY items.ordinality
        ) AS endpoints
      FROM jsonb_array_elements(${jsonbArrayOrEmpty(sql`list.data->'data'`)})
        WITH ORDINALITY AS items(item, ordinality)
      LEFT JOIN ai_gateway_metadata_cache AS endpoints_row
        ON endpoints_row.url = ${gatewayModelEndpointsUrlPrefix(gateway)} || (${item}->>'id') || ${GATEWAY_MODEL_ENDPOINTS_URL_SUFFIX}
    ) AS projected
    WHERE list.url = ${source.url}
  `);
  const [row] = result.rows;
  if (!row) return null;
  return source.parse(row.models).data.map((model, index) => ({
    model,
    endpoints: parseStoredGatewayModelEndpoints(row.endpoints[index]),
  }));
}

export type JoinedGatewayModels = {
  models: GatewayModelMap;
  withoutEndpointsResource: string[];
  withoutStoredEndpoints: string[];
};

/**
 * Models without an endpoints resource, or whose endpoints are unknown, are left out. Throws when
 * fewer than 100 models remain, the check that guarded every stored snapshot before.
 */
export function joinGatewayModelEndpoints(
  gateway: Provider,
  listedModels: readonly ListedGatewayModel[]
): JoinedGatewayModels {
  const joined: GatewayModelMap = {};
  const withoutEndpointsResource: string[] = [];
  const withoutStoredEndpoints: string[] = [];
  for (const { model, endpoints } of listedModels) {
    if (endpoints === undefined) {
      withoutStoredEndpoints.push(model.id);
    } else if (endpoints === NO_ENDPOINTS_RESOURCE) {
      withoutEndpointsResource.push(model.id);
    } else {
      joined[model.id] = { ...model, endpoints };
    }
  }

  const count = Object.keys(joined).length;
  if (count < MINIMUM_GATEWAY_MODEL_COUNT) {
    throw new Error(
      `Suspicious: total number of ${gateway.type} models is ${count} < ${MINIMUM_GATEWAY_MODEL_COUNT}`
    );
  }
  return {
    models: joined,
    withoutEndpointsResource: withoutEndpointsResource.sort(),
    withoutStoredEndpoints: withoutStoredEndpoints.sort(),
  };
}

/**
 * The refresh job stores a model list before the endpoints of newly listed models, so a catalog can
 * briefly list models it cannot serve yet. A listed model without usable stored endpoints keeps its
 * previous entry. An alias retargeted to a model that is not usable yet keeps its previous entry
 * while that entry's target is still in the catalog, and is left out otherwise, so the alias never
 * resolves to a model the catalog leaves out.
 */
export function retainPreviousEntries(
  joined: JoinedGatewayModels,
  previous: GatewayModelMap
): GatewayModelMap {
  const models: GatewayModelMap = { ...joined.models };
  for (const modelId of joined.withoutStoredEndpoints) {
    if (Object.hasOwn(previous, modelId)) models[modelId] = previous[modelId];
  }
  const unusable = new Set(joined.withoutStoredEndpoints.filter(id => !Object.hasOwn(models, id)));
  for (const [modelId, model] of Object.entries(models)) {
    const target = model.alias_target?.slug;
    if (target === undefined || !unusable.has(target)) continue;
    const previousEntry = Object.hasOwn(previous, modelId) ? previous[modelId] : undefined;
    const previousTarget = previousEntry?.alias_target?.slug;
    if (previousEntry && (previousTarget === undefined || Object.hasOwn(models, previousTarget))) {
      models[modelId] = previousEntry;
    } else {
      delete models[modelId];
    }
  }
  return models;
}
