import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { resolveSecret } from './auth.js';
import { DEFAULT_BACKEND_URL } from './constants.js';
import { logger } from './logger.js';
import { dispatchedKilocodeModelId } from './persistence/model-utils.js';
import type { PersistenceEnv } from './persistence/types.js';

const MODEL_VALIDATION_TIMEOUT_MS = 5_000;
const MODEL_VALIDATION_MAX_ATTEMPTS = 3;
const MODEL_VALIDATION_RETRY_BASE_DELAY_MS = 100;
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is not available for this cloud agent session';
const MODEL_VALIDATION_UNAVAILABLE_MESSAGE = 'Model availability could not be verified';

type ModelValidationEnv = Pick<
  PersistenceEnv,
  'KILOCODE_BACKEND_BASE_URL' | 'KILO_OPENROUTER_BASE' | 'KILOCODE_ORG_ID_OVERRIDE'
> &
  Partial<Pick<PersistenceEnv, 'NEXTAUTH_SECRET'>>;

type EffectiveCatalogContext = {
  token?: string;
  organizationId?: string;
  feature: string;
  runtimeCredential?: boolean;
  proof?: string;
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

type EndpointValidationResult =
  | { type: 'validated'; valid: boolean }
  | { type: 'http-error'; status: number }
  | { type: 'unavailable' };

function effectiveCatalogContext(input: AssertKiloModelAvailableInput): EffectiveCatalogContext {
  return {
    token: input.originalToken,
    organizationId: input.env.KILOCODE_ORG_ID_OVERRIDE ?? input.originalOrganizationId,
    feature: input.createdOnPlatform ?? 'cloud-agent',
  };
}

function requestHeaders(context: EffectiveCatalogContext): Headers {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('X-KiloCode-Feature', context.feature);
  if (context.proof) headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, context.proof);
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

function isTransientValidationStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function waitBeforeValidationRetry(attempt: number): Promise<void> {
  const delayMs = MODEL_VALIDATION_RETRY_BASE_DELAY_MS * 2 ** attempt;
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

async function validateEndpoint(url: string, init: RequestInit): Promise<EndpointValidationResult> {
  for (let attempt = 0; attempt < MODEL_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(url, init);
    if (!response) {
      if (attempt < MODEL_VALIDATION_MAX_ATTEMPTS - 1) {
        await waitBeforeValidationRetry(attempt);
      }
      continue;
    }

    if (!response.ok) {
      if (!isTransientValidationStatus(response.status)) {
        return { type: 'http-error', status: response.status };
      }
      if (attempt < MODEL_VALIDATION_MAX_ATTEMPTS - 1) {
        await waitBeforeValidationRetry(attempt);
      }
      continue;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (attempt < MODEL_VALIDATION_MAX_ATTEMPTS - 1) {
        await waitBeforeValidationRetry(attempt);
      }
      continue;
    }

    const parsed = officialValidationResponseSchema.safeParse(body);
    if (parsed.success) {
      return { type: 'validated', valid: parsed.data.valid };
    }
    if (attempt < MODEL_VALIDATION_MAX_ATTEMPTS - 1) {
      await waitBeforeValidationRetry(attempt);
    }
  }

  return { type: 'unavailable' };
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
  const result = await validateEndpoint(officialValidationUrl(env, context.organizationId), {
    method: 'POST',
    headers: requestHeaders(context),
    ...(context.runtimeCredential ? { redirect: 'manual' as const } : {}),
    body: JSON.stringify({ modelId }),
  });
  if (result.type === 'unavailable') {
    return { type: 'validation-unavailable', source: 'official' };
  }
  if (result.type === 'http-error') {
    if (result.status === 404 && !context.runtimeCredential)
      return { type: 'skipped', source: 'official' };
    if (result.status === 401 && context.runtimeCredential) {
      return { type: 'access-denied', source: 'official' };
    }
    if (result.status === 401 && (context.token || context.organizationId)) {
      return validateFromOfficialSource(env, modelId, anonymousCatalogContext(context.feature));
    }
    if (result.status === 403) return { type: 'access-denied', source: 'official' };
    return { type: 'validation-unavailable', source: 'official' };
  }
  return result.valid
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
  const result = await validateEndpoint(validationUrl, {
    method: 'POST',
    headers: requestHeaders(context),
    ...(context.runtimeCredential ? { redirect: 'manual' as const } : {}),
    body: JSON.stringify({ modelId }),
  });
  if (result.type === 'unavailable') {
    return { type: 'validation-unavailable', source: 'override' };
  }
  if (result.type === 'http-error') {
    if (result.status === 401 && context.runtimeCredential) {
      return { type: 'access-denied', source: 'override' };
    }
    if (result.status === 401 && (context.token || context.organizationId)) {
      return validateFromOfficialSource(env, modelId, anonymousCatalogContext(context.feature));
    }
    if (result.status === 403) return { type: 'access-denied', source: 'override' };
    return { type: 'validation-unavailable', source: 'override' };
  }
  return result.valid
    ? { type: 'valid', source: 'override' }
    : { type: 'unavailable-model', source: 'override' };
}

// Decoding only selects the stricter path; every claim used to issue proof is verified below.
async function attestCatalogContext(
  env: ModelValidationEnv,
  context: EffectiveCatalogContext,
  selectedUrl: string
): Promise<void> {
  if (!context.token) return;
  const encodedBase = catalogBaseUrlEncodedInToken(context.token);
  const token = encodedBase
    ? context.token.slice(context.token.lastIndexOf(':') + 1)
    : context.token;
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === 'string' || !('runtimeAuthorization' in decoded)) return;
  context.runtimeCredential = true;
  const deny = () =>
    new TRPCError({ code: 'FORBIDDEN', message: 'Model catalog authentication unavailable' });
  // Only the exact configured backend route may receive a runtime proof or bearer.
  if (encodedBase || selectedUrl !== officialValidationUrl(env, context.organizationId))
    throw deny();
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw deny();
  try {
    const audience = context.organizationId ? 'kilo-api' : 'kilo-gateway';
    const verified = await verifyKiloTokenForPolicy(token, secret, { audience, mode: 'required' });
    if (verified.claims.organizationId !== context.organizationId) throw deny();
    const authorization = verified.claims.runtimeAuthorization;
    if (!authorization || authorization.resourceKind !== 'cloud-agent-next') throw deny();
    context.proof = await issueRuntimeProxyAttestation({
      secret,
      audience,
      userId: verified.userId,
      authorizationId: authorization.id,
      resourceId: authorization.resourceId,
      bearer: token,
    });
  } catch {
    throw deny();
  }
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
  const selectedUrl = tokenSelectedBaseUrl
    ? `${tokenSelectedBaseUrl}/models/validate`
    : input.env.KILO_OPENROUTER_BASE
      ? buildKiloOverrideValidationUrl(input.env.KILO_OPENROUTER_BASE, context.organizationId)
      : officialValidationUrl(input.env, context.organizationId);
  await attestCatalogContext(input.env, context, selectedUrl);
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
