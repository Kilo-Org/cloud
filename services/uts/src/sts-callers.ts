import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  UTS_ACCOUNT_AUDIENCE,
  UTS_ACCOUNT_IMPORT_SCOPE,
  UTS_APP_EVENTS_SCOPE,
  UTS_AUTHORITY_SCOPE,
  UTS_INTERNAL_WORKLOADS,
  UTS_SUBJECT_OPERATIONS,
  UTS_TOKEN_EXCHANGE_ACTOR,
  UTS_TOKEN_EXCHANGE_STS_SCOPE,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import {
  createVerifier,
  httpJwksSource,
  type JwksSource,
  type VerifyFailure,
  type Verifier,
} from '@kilocode/verify';
import { z } from 'zod';
import type { UtsConfig } from './env';
import type { StsCallerVerifier } from './exchange/endpoint';
import type { ServiceTokenVerifier } from './subjects/service-tokens';

/**
 * The STS workloads each environment admits as callers of the mint Worker (design 6.1). Production
 * admits none until its callers are reviewed; a verified token from any other workload is refused.
 */
export const STS_CALLER_WORKLOADS: Readonly<
  Record<UtsEnvironment, { exchange: readonly string[]; internal: readonly string[] }>
> = {
  production: { exchange: [], internal: [] },
  staging: { exchange: [UTS_TOKEN_EXCHANGE_ACTOR], internal: [...UTS_INTERNAL_WORKLOADS] },
  development: { exchange: [UTS_TOKEN_EXCHANGE_ACTOR], internal: [...UTS_INTERNAL_WORKLOADS] },
};

/** The STS scopes of audience `uts`: the broker exchange and every `/internal/` route. */
const UTS_STS_SCOPES = [
  ...new Set([
    UTS_TOKEN_EXCHANGE_STS_SCOPE,
    ...Object.values(UTS_SUBJECT_OPERATIONS).map(operation => operation.scope),
    UTS_ACCOUNT_IMPORT_SCOPE,
    UTS_AUTHORITY_SCOPE,
    UTS_APP_EVENTS_SCOPE,
  ]),
];

/** How long a caller waits while the STS key set cannot be read and verify names no wait. */
const KEY_SET_RETRY_SECONDS = 30;

/** verify's `Retry-After`: whole seconds, at least 1. */
const RetryAfterSchema = z.coerce.number().int().positive();

/** One verifier per isolate and environment, so its key-set cache serves every request. */
let held: { key: string; verifier: Verifier<false> } | null = null;

function verifierFor(config: UtsConfig, jwks: (issuer: string) => JwksSource): Verifier<false> {
  const issuer = STS_ISSUERS[config.environment];
  const key = `${config.environment}|${issuer}`;
  if (held?.key !== key) {
    held = {
      key,
      verifier: createVerifier({
        audience: UTS_ACCOUNT_AUDIENCE,
        environment: config.environment,
        resourceMetadataUrl: `${config.endpoints.issuer}/.well-known/oauth-protected-resource`,
        sts: {
          issuer,
          jwks: jwks(issuer),
          scopeRegistry: { [UTS_ACCOUNT_AUDIENCE]: { scopes: UTS_STS_SCOPES } },
        },
      }),
    };
  }
  return held.verifier;
}

/** Drops the isolate's verifier; tests only. */
export function resetStsCallerVerifier(): void {
  held = null;
}

async function verifyBearer(
  config: UtsConfig,
  ctx: ExecutionContext,
  jwks: (issuer: string) => JwksSource,
  authorization: string,
  scope: string
) {
  const request = new Request(config.endpoints.issuer, { headers: { authorization } });
  return await verifierFor(config, jwks).verify(
    request,
    { issuer: 'sts', scope },
    { waitUntil: promise => ctx.waitUntil(promise) }
  );
}

/**
 * A failure the caller cannot fix: the STS key set (or another dependency) did not answer (503), or
 * verify refused to call it again yet (429).
 */
function isUnavailable(failure: VerifyFailure): boolean {
  return failure.status === 503 || failure.status === 429;
}

/** The wait verify set on the failure, or the default when it names none. */
function retryAfterOf(failure: VerifyFailure): number {
  const parsed = RetryAfterSchema.safeParse(failure.headers['retry-after']);
  return parsed.success ? parsed.data : KEY_SET_RETRY_SECONDS;
}

/**
 * The deployed STS checks: `@kilocode/verify` against this environment's STS issuer and key set,
 * audience `uts`, one route scope, and the environment's workload allow-lists. An unreadable key
 * set fails closed: `unavailable`, never admitted. `stsCallers` is null where no workload may
 * call the exchange.
 */
export function deployedStsCallers(
  config: UtsConfig,
  ctx: ExecutionContext,
  jwks: (issuer: string) => JwksSource = httpJwksSource
): { serviceTokens: ServiceTokenVerifier; stsCallers: StsCallerVerifier | null } {
  const workloads = STS_CALLER_WORKLOADS[config.environment];
  return {
    serviceTokens: async (authorization, scope) => {
      if (authorization === null) return { status: 'missing' };
      const result = await verifyBearer(config, ctx, jwks, authorization, scope);
      if (!result.ok) {
        if (isUnavailable(result)) {
          return { status: 'unavailable', retryAfterSeconds: retryAfterOf(result) };
        }
        if (result.reason === 'missing_credential') return { status: 'missing' };
        return { status: result.status === 403 ? 'insufficient_scope' : 'invalid' };
      }
      if (
        result.caller.kind !== 'service' ||
        !workloads.internal.includes(result.caller.workload)
      ) {
        return { status: 'insufficient_scope' };
      }
      return { status: 'verified', workload: result.caller.workload };
    },
    // An environment that admits no exchange caller does not offer the exchange
    // (`unsupported_grant_type`, and no `token-exchange` in its metadata).
    stsCallers:
      workloads.exchange.length === 0
        ? null
        : async token => {
            const result = await verifyBearer(
              config,
              ctx,
              jwks,
              `Bearer ${token}`,
              UTS_TOKEN_EXCHANGE_STS_SCOPE
            );
            if (!result.ok) return { status: isUnavailable(result) ? 'unavailable' : 'invalid' };
            if (
              result.caller.kind !== 'service' ||
              !workloads.exchange.includes(result.caller.workload)
            ) {
              return { status: 'invalid' };
            }
            return {
              status: 'verified',
              caller: { workload: result.caller.workload, scope: UTS_TOKEN_EXCHANGE_STS_SCOPE },
            };
          },
  };
}
