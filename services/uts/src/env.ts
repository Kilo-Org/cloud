import type { BundleBinding } from '@kilocode/secrets-client';
import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { AttestEnv } from './attest/config';
import type { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
import type { UtsKeySetDO } from './dos/UtsKeySetDO';
import type { UtsLoginRotationDO } from './dos/UtsLoginRotationDO';
import type { UtsManagerAuthDO } from './dos/UtsManagerAuthDO';
import type { UtsSignerDO } from './dos/UtsSignerDO';
import type { UtsFeedDO } from './feed/UtsFeedDO';
import type { SignInEnv } from './signin/providers/config';

const HostSchema = z
  .string()
  .regex(/^(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/);

/** An origin with nothing after it: `https://host[:port]`, or `http://localhost:<port>`. */
const OriginSchema = z.string().refine(value => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, 'an origin');

/**
 * Production and staging keep every UTS Durable Object in the `eu` jurisdiction (design 5.7).
 * workerd enforces no residency, so `wrangler dev` and the test pool run unscoped.
 *
 * `PAT_LOOKUP_CONNECTIONS` is the connection limit of the environment's PAT lookup Hyperdrive
 * config, as a decimal string; the per-isolate PAT lookup cap derives from it
 * (`patLookupsInFlight`). Staging and production must set it; development may leave it out.
 */
const EnvVarsSchema = z
  .object({
    UTS_ENVIRONMENT: UtsEnvironmentSchema,
    DO_JURISDICTION: z.enum(['eu', 'none']),
    PAT_LOOKUP_CONNECTIONS: z
      .string()
      .regex(/^[1-9][0-9]{0,3}$/, 'a connection count from 1 to 9999')
      .transform(Number)
      .optional(),
    WEBAUTHN_RP_ID: HostSchema,
    WEBAUTHN_ORIGINS: z
      .string()
      .transform(value => value.split(','))
      .pipe(z.array(OriginSchema).min(1).max(4)),
    MANAGER_BASE_URL: OriginSchema.optional(),
    LOGIN_ROTATION: z.enum(['on', 'off']).optional(),
    CLOUDFLARE_API_BASE_URL: OriginSchema.optional(),
    LOGIN_ROTATION_PERIOD_SECONDS: z
      .string()
      .regex(/^[1-9][0-9]{0,7}$/, 'a period from 1 second')
      .transform(seconds => Number(seconds) * 1000)
      .optional(),
  })
  .refine(
    vars => (vars.UTS_ENVIRONMENT === 'development') === (vars.DO_JURISDICTION === 'none'),
    'production and staging pin Durable Objects to the eu jurisdiction; only development runs unscoped'
  )
  .refine(
    vars => vars.UTS_ENVIRONMENT === 'development' || vars.PAT_LOOKUP_CONNECTIONS !== undefined,
    'production and staging set PAT_LOOKUP_CONNECTIONS, the PAT lookup config connection limit'
  )
  .refine(
    vars =>
      vars.UTS_ENVIRONMENT === 'development'
        ? vars.WEBAUTHN_RP_ID === 'localhost' &&
          vars.WEBAUTHN_ORIGINS.every(origin => new URL(origin).hostname === 'localhost')
        : vars.WEBAUTHN_ORIGINS.every(origin => origin.startsWith('https://')),
    'WebAuthn runs on https origins, and on localhost only in development'
  )
  .refine(
    vars => vars.UTS_ENVIRONMENT === 'development' || vars.MANAGER_BASE_URL === undefined,
    'only development names its manager; staging and production use Infisical Cloud'
  )
  .refine(
    vars =>
      vars.UTS_ENVIRONMENT === 'development' ||
      (vars.CLOUDFLARE_API_BASE_URL === undefined &&
        vars.LOGIN_ROTATION_PERIOD_SECONDS === undefined),
    'only development names a Cloudflare API stand-in or a rotation period'
  );

/** 30 days, the period of a deployed rotation, and of development unless it names its own. */
const DEFAULT_ROTATION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** Design 3: at most 100 PAT lookups in flight per mint isolate. */
export const MAX_PAT_LOOKUPS_IN_FLIGHT = 100;

/**
 * The WebAuthn relying party of the sign-in pages (design 5.14). `rpId` is the host whose passkeys
 * users hold: the app host in production, the issuer host in staging and development; `origins` are
 * the pages that run the ceremonies, the issuer origin in a deployed environment, which the
 * production app host lists as a WebAuthn related origin.
 */
export type RelyingParty = { rpId: string; origins: readonly string[] };

export type UtsConfig = {
  environment: UtsEnvironment;
  endpoints: UtsEndpoints;
  jurisdiction: 'eu' | 'none';
  relyingParty: RelyingParty;
  /** Development only: the stand-in manager's origin (src/manager/config.ts). */
  managerBaseUrl: string | null;
  /** The identity-store login rotation switch (src/rotation/config.ts); off unless `LOGIN_ROTATION=on`. */
  loginRotation:
    | { status: 'off' }
    | {
        status: 'on';
        /** Development only: a stand-in Cloudflare API origin; null elsewhere. */
        cloudflareBaseUrl: string | null;
        /** The rotation period; only development sets one other than 30 days. */
        periodMs: number;
      };
};

export type Env = {
  UTS_ENVIRONMENT: string;
  DO_JURISDICTION: string;
  /** Required in staging and production (`EnvVarsSchema`). */
  PAT_LOOKUP_CONNECTIONS?: string;
  UTS_SIGNER_DO: DurableObjectNamespace<UtsSignerDO>;
  UTS_KEY_SET_DO: DurableObjectNamespace<UtsKeySetDO>;
  /** One audit outbox relay object per audit shard (src/audit/relay.ts). */
  UTS_AUDIT_RELAY_DO: DurableObjectNamespace<UtsAuditRelayDO>;
  /** The environment's UTS audit queue, which only UTS produces to and the audit relay consumes. */
  AUDIT_QUEUE: Queue;
  /**
   * The two revocation-feed objects. Only this Worker binds them, so only it writes entries; the
   * feed Worker reads heads and lists through the `FeedReads` entrypoint (src/feed/reads.ts).
   */
  UTS_FEED_DO: DurableObjectNamespace<UtsFeedDO>;
  /** The one object that holds the manager login key (src/dos/UtsManagerAuthDO.ts). */
  UTS_MANAGER_AUTH_DO: DurableObjectNamespace<UtsManagerAuthDO>;
  /** The one identity-store login rotation object (src/dos/UtsLoginRotationDO.ts). */
  UTS_LOGIN_ROTATION_DO: DurableObjectNamespace<UtsLoginRotationDO>;
  /** `on` runs the login rotation job from the cron; absent or `off` keeps it off. */
  LOGIN_ROTATION?: string;
  /**
   * The STS secrets broker, to be bound as caller `uts` once STS has a `uts` policy. It delivers the
   * rotation job's Hyperdrive switch token (src/rotation/secrets.ts).
   */
  STS?: BundleBinding;
  /** Development only: JSON with the switch token a local run uses instead of STS. */
  UTS_LOCAL_SECRETS?: string;
  /** Development only: origin of a stand-in Cloudflare API for the local end-to-end run. */
  CLOUDFLARE_API_BASE_URL?: string;
  /** Development only: the rotation period in seconds. */
  LOGIN_ROTATION_PERIOD_SECONDS?: string;
  /**
   * The identity store's primary Hyperdrive config, bound once the environment's identity store is
   * provisioned. `identityStoreBinding` (src/grants/binding.ts) is the only reader.
   */
  IDENTITY_STORE?: Hyperdrive;
  /**
   * The identity store's PAT lookup Hyperdrive config (login `uts_pat`), bound once the
   * environment's identity store is provisioned; it serves PAT lookups only (design 5.2).
   * `patStoreBinding` (src/pat/lookup.ts) is the only reader.
   */
  IDENTITY_STORE_PAT?: Hyperdrive;
  /**
   * The identity store's read-replica Hyperdrive config (login `uts_reader`, views in `uts_read`),
   * bound once the environment's identity store is provisioned; it serves read-only account views
   * such as the security view (design 5.2).
   */
  IDENTITY_STORE_REPLICA?: Hyperdrive;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_ORIGINS: string;
  /** Development only: origin of a stand-in secrets manager for the local end-to-end run. */
  MANAGER_BASE_URL?: string;
  /**
   * The HMAC key of RFC 8628 user codes, 32 bytes in base64url, a Worker secret. The device grant
   * is served only where it is set (src/signin/device/user-code.ts).
   */
  DEVICE_USER_CODE_KEY?: string;
  /**
   * The public keys of the web BFF `kilo-web` (`KiloWebClientJwksSchema`): one or two Ed25519
   * JWKs as JSON. `kilo-web` is served only where it is set (src/bff/client-auth.ts).
   */
  KILO_WEB_CLIENT_JWKS?: string;
  /** `true` turns on the `kilo-web` legacy bridge (src/bff/token.ts); anything else keeps it off. */
  LEGACY_BRIDGE_ENABLED?: string;
} & SignInEnv &
  AttestEnv;

/**
 * The feed Worker's deployed name in each environment. It is the only caller the `SignerKeys`
 * entrypoint answers, and the `props.caller` its binding carries.
 */
export const FEED_DEPLOYMENTS: Readonly<Record<UtsEnvironment, string>> = {
  production: 'uts-feed',
  staging: 'uts-feed-staging',
  development: 'uts-feed-local',
};

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): UtsConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.UTS_ENVIRONMENT,
    endpoints: UTS_ENDPOINTS[vars.UTS_ENVIRONMENT],
    jurisdiction: vars.DO_JURISDICTION,
    relyingParty: { rpId: vars.WEBAUTHN_RP_ID, origins: vars.WEBAUTHN_ORIGINS },
    managerBaseUrl: vars.MANAGER_BASE_URL ?? null,
    loginRotation:
      vars.LOGIN_ROTATION === 'on'
        ? {
            status: 'on',
            cloudflareBaseUrl: vars.CLOUDFLARE_API_BASE_URL ?? null,
            periodMs: vars.LOGIN_ROTATION_PERIOD_SECONDS ?? DEFAULT_ROTATION_PERIOD_MS,
          }
        : { status: 'off' },
  };
}

/**
 * The per-isolate cap on PAT lookups in flight (design 3): min(100, 3 × `PAT_LOOKUP_CONNECTIONS`),
 * so one isolate never queues more than 3 lookups per PAT config connection. Development without
 * the var uses 100.
 */
export function patLookupsInFlight(env: Env): number {
  const connections = EnvVarsSchema.parse(env).PAT_LOOKUP_CONNECTIONS;
  return connections === undefined
    ? MAX_PAT_LOOKUPS_IN_FLIGHT
    : Math.min(MAX_PAT_LOOKUPS_IN_FLIGHT, 3 * connections);
}
