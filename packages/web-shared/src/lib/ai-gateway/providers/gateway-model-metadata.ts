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
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

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

const storedGatewayModelsRowSchema = z.object({
  models: z.unknown(),
  endpoints: z.record(z.string(), z.unknown()),
});

export type StoredGatewayModels = {
  models: GatewayModel[];
  /** Models whose endpoints row is missing or does not parse have no entry. */
  endpoints: ReadonlyMap<string, GatewayModelEndpoints>;
};

export function formatModelIds(modelIds: readonly string[]) {
  const listed = modelIds.slice(0, LOGGED_MODEL_ID_LIMIT).join(', ');
  return modelIds.length > LOGGED_MODEL_ID_LIMIT
    ? `${listed} and ${modelIds.length - LOGGED_MODEL_ID_LIMIT} more`
    : listed;
}

/**
 * Reads a stored gateway model list and the stored endpoints of every listed model in one query.
 * Returns null when the list is not stored. Throws when the query fails or the list fails
 * `source.parse`, including its truncation check, so a cached caller keeps its last good value.
 */
export async function readStoredGatewayModels(
  gateway: Provider,
  source: MetadataSource<GatewayModelList>,
  fromDb: MetadataDb
): Promise<StoredGatewayModels | null> {
  const item = sql`items.item`;
  const endpointsData = sql`endpoints_row.data`;
  const endpointsList = sql`${endpointsData}->'data'->'endpoints'`;
  const result = await fromDb.execute(sql`
    SELECT
      CASE WHEN jsonb_typeof(list.data->'data') = 'array'
        THEN jsonb_build_object('data', coalesce(projected.models, '[]'::jsonb))
        ELSE list.data
      END AS models,
      coalesce(projected.endpoints, '{}'::jsonb) AS endpoints
    FROM ai_gateway_metadata_cache AS list
    CROSS JOIN LATERAL (
      SELECT
        jsonb_agg(
          ${pickJsonbKeys(item, ModelSchema.keyof().options, {
            architecture: ModelArchitectureSchema.keyof().options,
          })}
          ORDER BY items.ordinality
        ) AS models,
        jsonb_object_agg(
          ${item}->>'id',
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
            ELSE ${endpointsData}
          END
        ) FILTER (WHERE jsonb_typeof(${item}->'id') = 'string' AND ${endpointsData} IS NOT NULL)
          AS endpoints
      FROM jsonb_array_elements(${jsonbArrayOrEmpty(sql`list.data->'data'`)})
        WITH ORDINALITY AS items(item, ordinality)
      LEFT JOIN ai_gateway_metadata_cache AS endpoints_row
        ON endpoints_row.url = ${gatewayModelEndpointsUrlPrefix(gateway)} || (${item}->>'id') || ${GATEWAY_MODEL_ENDPOINTS_URL_SUFFIX}
    ) AS projected
    WHERE list.url = ${source.url}
  `);
  const [row] = result.rows;
  if (!row) return null;
  const stored = storedGatewayModelsRowSchema.parse(row);
  const models = source.parse(stored.models).data;

  const endpoints = new Map<string, GatewayModelEndpoints>();
  const unparseable: string[] = [];
  for (const [modelId, raw] of Object.entries(stored.endpoints)) {
    try {
      endpoints.set(modelId, parseGatewayModelEndpoints(raw));
    } catch {
      unparseable.push(modelId);
    }
  }
  if (unparseable.length > 0) {
    warnExceptInTest(
      `[readStoredGatewayModels] stored ${gateway.type} endpoints are unusable for ${unparseable.length} models: ${formatModelIds(unparseable.sort())}`
    );
  }
  return { models, endpoints };
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
  models: readonly GatewayModel[],
  endpointsByModelId: ReadonlyMap<string, GatewayModelEndpoints>
): JoinedGatewayModels {
  const joined: GatewayModelMap = {};
  const withoutEndpointsResource: string[] = [];
  const withoutStoredEndpoints: string[] = [];
  for (const model of models) {
    const endpoints = endpointsByModelId.get(model.id);
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
