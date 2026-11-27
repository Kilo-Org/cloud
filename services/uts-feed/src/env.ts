import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  UTS_ENDPOINTS,
  UTS_FEED_HTTPS_WORKLOADS,
  UtsEnvironmentSchema,
  type FeedReadsBinding,
  type SignerKeysBinding,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';

export type Env = {
  UTS_ENVIRONMENT: string;
  /**
   * The mint Worker's `SignerKeys` entrypoint, bound with this Worker's deployed name as
   * `props.caller`. Placement does not apply to a named entrypoint, so the read runs where this
   * Worker runs.
   */
  UTS_MINT: SignerKeysBinding;
  /**
   * The mint Worker's `FeedReads` entrypoint, bound the same way: the heads and lists of the two
   * feed objects, which only the mint Worker binds.
   */
  UTS_FEED_READS: FeedReadsBinding;
  /** This deployment's version; its id keeps the feed's cache entries private (src/revocation.ts). */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /**
   * The switch of the HTTPS feed (head, list and bootstrap). Only the exact string `true` turns it
   * on; anything else, absent included, answers those paths 503 with `Retry-After`.
   */
  FEED_HTTPS_ENABLED?: string;
  /**
   * The STS issuer whose service tokens the HTTPS feed accepts: the `iss` it requires and the base
   * of the key-set URL. It must be `STS_ISSUERS` of this Worker's environment; development may
   * also name a loopback origin (the local end-to-end runs). Absent or another value: 503.
   */
  STS_URL?: string;
};

/**
 * The HTTPS feed's state in this deployment, one union: `off` while the switch is not exactly
 * `true`; `unconfigured` while the switch is on but no STS issuer of this environment is set (the
 * verifier cannot run); `on` with the issuer and the workloads it admits.
 */
export type FeedHttps =
  | { status: 'off' }
  | { status: 'unconfigured' }
  | { status: 'on'; stsIssuer: string; workloads: readonly string[] };

export type FeedConfig = {
  environment: UtsEnvironment;
  endpoints: UtsEndpoints;
  /** A path segment no other Worker on the zone knows: this deployment's version id. */
  cacheSegment: string;
  https: FeedHttps;
};

const EnvVarsSchema = z.object({
  UTS_ENVIRONMENT: UtsEnvironmentSchema,
  CF_VERSION_METADATA: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }),
  FEED_HTTPS_ENABLED: z.string().optional(),
  STS_URL: z.string().optional(),
});

const LoopbackUrlSchema = z.url({ protocol: /^http$/, hostname: /^(localhost|127\.0\.0\.1)$/ });

/**
 * The STS issuer `stsUrl` names for `environment`, or null: exactly that environment's
 * `STS_ISSUERS` entry, or in development a bare loopback `http:` origin (no path or trailing
 * slash), which the verification library accepts as an issuer.
 */
function stsIssuerOf(environment: UtsEnvironment, stsUrl: string | undefined): string | null {
  if (stsUrl === undefined) return null;
  if (stsUrl === STS_ISSUERS[environment]) return stsUrl;
  if (environment !== 'development') return null;
  const loopback = LoopbackUrlSchema.safeParse(stsUrl);
  return loopback.success && new URL(loopback.data).origin === stsUrl ? stsUrl : null;
}

function httpsOf(environment: UtsEnvironment, vars: z.infer<typeof EnvVarsSchema>): FeedHttps {
  if (vars.FEED_HTTPS_ENABLED !== 'true') return { status: 'off' };
  const stsIssuer = stsIssuerOf(environment, vars.STS_URL);
  if (stsIssuer === null) return { status: 'unconfigured' };
  return { status: 'on', stsIssuer, workloads: UTS_FEED_HTTPS_WORKLOADS[environment] };
}

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): FeedConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.UTS_ENVIRONMENT,
    endpoints: UTS_ENDPOINTS[vars.UTS_ENVIRONMENT],
    cacheSegment: vars.CF_VERSION_METADATA.id,
    https: httpsOf(vars.UTS_ENVIRONMENT, vars),
  };
}
