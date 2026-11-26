import { UTS_ACCOUNT_AUDIENCE } from '@kilocode/uts-contracts';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Env } from './env';
import type { StsCallerVerifier } from './exchange/endpoint';
import type { MetadataFetcher } from './third-party/metadata';

/**
 * Development-only stand-ins for the local end-to-end run of third-party clients and the broker
 * exchange (`scripts/clients-e2e.ts`). Only `src/dev.ts` reaches this module, under the
 * development entry, and each part stays off unless its var is set:
 *
 * * `DEV_CLIENT_METADATA_ORIGIN`: a client id on a reserved test domain (`*.example`,
 *   `*.example.com`, RFC 2606) is fetched from this local origin, path kept, instead of its own
 *   host, so the run can serve its Client ID Metadata Documents. Every other client id keeps the
 *   platform `fetch`, and the URL guards and document checks apply unchanged.
 * * `DEV_STS_JWKS_URL`: the broker exchange accepts STS tokens signed by the run's fake STS signer,
 *   whose public keys this URL serves. The tokens carry the STS service-token profile of the
 *   development STS issuer (`@kilocode/sts-contracts`, phase 2): `EdDSA`, `typ` `at+jwt`, audience
 *   `uts`, `sub` `service:<workload>`, `client_id` and `req` the workload, one scope, `env`
 *   `development`, at most 5 minutes. `@kilocode/verify` replaces this once it is on this branch.
 */

const DevVarsSchema = z.looseObject({
  DEV_CLIENT_METADATA_ORIGIN: z.url().optional(),
  DEV_STS_JWKS_URL: z.url().optional(),
});

/** `STS_ISSUERS.development` of `@kilocode/sts-contracts`. */
const DEVELOPMENT_STS_ISSUER = 'http://localhost:8825';
const SERVICE_TOKEN_MAX_SECONDS = 300;
const TEST_DOMAIN = /(^|\.)example(\.com)?$/;

const ServiceClaimsSchema = z.looseObject({
  iss: z.literal(DEVELOPMENT_STS_ISSUER),
  aud: z.literal(UTS_ACCOUNT_AUDIENCE),
  sub: z.string().regex(/^service:[a-z0-9-]+$/),
  client_id: z.string().regex(/^[a-z0-9-]+$/),
  req: z.string(),
  scope: z.string().regex(/^[a-z0-9-]+:[a-z0-9_.-]+$/),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  env: z.literal('development'),
});

export function devMetadataFetcher(env: Env): MetadataFetcher | null {
  const origin = DevVarsSchema.parse(env).DEV_CLIENT_METADATA_ORIGIN;
  if (origin === undefined) return null;
  return async (url, init) => {
    const target = new URL(url);
    if (!TEST_DOMAIN.test(target.hostname)) return await fetch(url, init);
    return await fetch(new URL(`${target.pathname}${target.search}`, origin).toString(), init);
  };
}

/** One remote key set per isolate and URL; `jose` caches its keys and refetches on a new `kid`. */
const keySets = new Map<string, JWTVerifyGetKey>();

export function devStsCallers(env: Env): StsCallerVerifier | null {
  const jwksUrl = DevVarsSchema.parse(env).DEV_STS_JWKS_URL;
  if (jwksUrl === undefined) return null;
  let keySet = keySets.get(jwksUrl);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 2_000 });
    keySets.set(jwksUrl, keySet);
  }
  const keys = keySet;
  return async token => {
    let payload;
    try {
      payload = (
        await jwtVerify(token, keys, {
          algorithms: ['EdDSA'],
          typ: 'at+jwt',
          issuer: DEVELOPMENT_STS_ISSUER,
          audience: UTS_ACCOUNT_AUDIENCE,
          clockTolerance: 60,
        })
      ).payload;
    } catch (error) {
      return error instanceof Error && error.name === 'JWKSTimeout'
        ? { status: 'unavailable' }
        : { status: 'invalid' };
    }
    const claims = ServiceClaimsSchema.safeParse(payload);
    if (
      !claims.success ||
      claims.data.sub !== `service:${claims.data.client_id}` ||
      claims.data.req !== claims.data.client_id ||
      claims.data.exp - claims.data.iat > SERVICE_TOKEN_MAX_SECONDS
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'verified',
      caller: { workload: claims.data.client_id, scope: claims.data.scope },
    };
  };
}
