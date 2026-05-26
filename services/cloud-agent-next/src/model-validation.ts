import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { DEFAULT_BACKEND_URL } from './constants.js';
import { logger } from './logger.js';
import { dispatchedKilocodeModelId } from './persistence/model-utils.js';
import type { PersistenceEnv } from './persistence/types.js';

const MODEL_VALIDATION_TIMEOUT_MS = 5_000;
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is not available for this cloud agent session';
const MODEL_VALIDATION_UNAVAILABLE_MESSAGE = 'Model availability could not be verified';

type ModelValidationEnv = Pick<
  PersistenceEnv,
  | 'KILOCODE_BACKEND_BASE_URL'
  | 'KILO_OPENROUTER_BASE'
  | 'KILOCODE_TOKEN_OVERRIDE'
  | 'KILOCODE_ORG_ID_OVERRIDE'
>;

type EffectiveCatalogContext = {
  token?: string;
  organizationId?: string;
  feature: string;
};

type ModelValidationResult =
  | { type: 'valid'; source: 'official' | 'override' }
  | { type: 'skipped'; source: 'official' }
  | { type: 'unavailable-model'; source: 'official' | 'override' }
  | { type: 'access-denied'; source: 'official' | 'override' }
  | { type: 'validation-unavailable'; source: 'official' | 'override' };

export type AssertKiloModelAvailableInput = {
  env: ModelValidationEnv;
  submittedModel: string | undefined | null;
  originalToken?: string;
  originalOrganizationId?: string;
  createdOnPlatform?: string;
  procedure: string;
};

const officialValidationResponseSchema = z.union([
  z.object({ valid: z.literal(true) }),
  z.object({ valid: z.literal(false), reason: z.literal('unavailable') }),
]);

function effectiveCatalogContext(input: AssertKiloModelAvailableInput): EffectiveCatalogContext {
  return {
    token: input.env.KILOCODE_TOKEN_OVERRIDE ?? input.originalToken,
    organizationId: input.env.KILOCODE_ORG_ID_OVERRIDE ?? input.originalOrganizationId,
    feature: input.createdOnPlatform ?? 'cloud-agent',
  };
}

function requestHeaders(context: EffectiveCatalogContext): Headers {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('X-KiloCode-Feature', context.feature);
  if (context.token) headers.set('Authorization', `Bearer ${context.token}`);
  if (context.organizationId) {
    headers.set('X-KiloCode-OrganizationId', context.organizationId);
  }
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(MODEL_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

function anonymousCatalogContext(feature: string): EffectiveCatalogContext {
  return { feature };
}

function officialValidationUrl(
  env: ModelValidationEnv,
  organizationId: string | undefined
): string {
  const backendUrl = (env.KILOCODE_BACKEND_BASE_URL ?? DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  return organizationId
    ? `${backendUrl}/api/organizations/${encodeURIComponent(organizationId)}/models/validate`
    : `${backendUrl}/api/openrouter/models/validate`;
}

async function validateFromOfficialSource(
  env: ModelValidationEnv,
  modelId: string,
  context: EffectiveCatalogContext
): Promise<ModelValidationResult> {
  const response = await fetchWithTimeout(officialValidationUrl(env, context.organizationId), {
    method: 'POST',
    headers: requestHeaders(context),
    body: JSON.stringify({ modelId }),
  });
  if (!response) return { type: 'validation-unavailable', source: 'official' };
  if (response.status === 404) return { type: 'skipped', source: 'official' };
  if (response.status === 401 && (context.token || context.organizationId)) {
    return validateFromOfficialSource(env, modelId, anonymousCatalogContext(context.feature));
  }
  if (response.status === 403) return { type: 'access-denied', source: 'official' };
  if (!response.ok) return { type: 'validation-unavailable', source: 'official' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { type: 'validation-unavailable', source: 'official' };
  }
  const parsed = officialValidationResponseSchema.safeParse(body);
  if (!parsed.success) return { type: 'validation-unavailable', source: 'official' };
  return parsed.data.valid
    ? { type: 'valid', source: 'official' }
    : { type: 'unavailable-model', source: 'official' };
}

export function buildKiloOverrideValidationUrl(
  baseURL: string,
  organizationId: string | undefined
): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  let modelsBaseUrl: string;
  if (organizationId) {
    const encodedOrganizationId = encodeURIComponent(organizationId);
    modelsBaseUrl = trimmed.includes('/api/organizations/')
      ? trimmed
      : trimmed.endsWith('/api')
        ? `${trimmed}/organizations/${encodedOrganizationId}`
        : `${trimmed}/api/organizations/${encodedOrganizationId}`;
  } else {
    modelsBaseUrl = trimmed.includes('/openrouter')
      ? trimmed
      : trimmed.endsWith('/api')
        ? `${trimmed}/openrouter`
        : `${trimmed}/api/openrouter`;
  }
  return `${modelsBaseUrl}/models/validate`;
}

function catalogBaseUrlEncodedInToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const match = token.match(/^(https?:\/\/[^:]+(?::\d+)?(?:\/[^:]*)?):/);
  if (!match) return undefined;
  try {
    return new URL(match[1]).toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

async function validateFromOverrideSource(
  env: ModelValidationEnv,
  baseURL: string,
  modelId: string,
  context: EffectiveCatalogContext,
  tokenSelectedSource = false
): Promise<ModelValidationResult> {
  const validationUrl = tokenSelectedSource
    ? `${baseURL}/models/validate`
    : buildKiloOverrideValidationUrl(baseURL, context.organizationId);
  const response = await fetchWithTimeout(validationUrl, {
    method: 'POST',
    headers: requestHeaders(context),
    body: JSON.stringify({ modelId }),
  });
  if (!response) return { type: 'validation-unavailable', source: 'override' };
  if (response.status === 401 && (context.token || context.organizationId)) {
    return validateFromOfficialSource(env, modelId, anonymousCatalogContext(context.feature));
  }
  if (response.status === 403) return { type: 'access-denied', source: 'override' };
  if (!response.ok) return { type: 'validation-unavailable', source: 'override' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { type: 'validation-unavailable', source: 'override' };
  }
  const parsed = officialValidationResponseSchema.safeParse(body);
  if (!parsed.success) return { type: 'validation-unavailable', source: 'override' };
  return parsed.data.valid
    ? { type: 'valid', source: 'override' }
    : { type: 'unavailable-model', source: 'override' };
}

export async function assertKiloModelAvailable(
  input: AssertKiloModelAvailableInput
): Promise<void> {
  const modelId = dispatchedKilocodeModelId(input.submittedModel);
  if (!modelId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No model specified and session has no default model',
    });
  }

  const context = effectiveCatalogContext(input);
  const startTime = Date.now();
  const tokenSelectedBaseUrl = catalogBaseUrlEncodedInToken(context.token);
  const result = tokenSelectedBaseUrl
    ? await validateFromOverrideSource(input.env, tokenSelectedBaseUrl, modelId, context, true)
    : input.env.KILO_OPENROUTER_BASE
      ? await validateFromOverrideSource(
          input.env,
          input.env.KILO_OPENROUTER_BASE,
          modelId,
          context
        )
      : await validateFromOfficialSource(input.env, modelId, context);
  const fields = {
    procedure: input.procedure,
    catalogSource: result.source,
    organizationPresent: Boolean(context.organizationId),
    model: modelId,
    responseClass: result.type,
    elapsedMs: Date.now() - startTime,
  };

  if (result.type === 'valid') {
    logger.withFields(fields).info('Model availability validated');
    return;
  }
  if (result.type === 'skipped') {
    logger
      .withFields(fields)
      .warn('Model availability validation skipped after official 404 response');
    return;
  }
  if (result.type === 'unavailable-model') {
    logger.withFields(fields).warn('Selected model is unavailable');
    throw new TRPCError({ code: 'BAD_REQUEST', message: MODEL_UNAVAILABLE_MESSAGE });
  }
  if (result.type === 'access-denied') {
    logger.withFields(fields).warn('Model catalog access denied');
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Model catalog access denied for this cloud agent session',
    });
  }

  logger.withFields(fields).error('Model validation unavailable');
  throw new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: MODEL_VALIDATION_UNAVAILABLE_MESSAGE,
    cause: {
      error: 'MODEL_VALIDATION_UNAVAILABLE',
      message: MODEL_VALIDATION_UNAVAILABLE_MESSAGE,
      retryable: true,
    },
  });
}
