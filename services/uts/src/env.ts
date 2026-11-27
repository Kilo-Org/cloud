import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { UtsAuditRelayDO } from './dos/UtsAuditRelayDO';
import type { UtsKeySetDO } from './dos/UtsKeySetDO';
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
  );

/** Design 3: at most 100 PAT lookups in flight per mint isolate. */
export const MAX_PAT_LOOKUPS_IN_FLIGHT = 100;

/**
 * The WebAuthn relying party of the sign-in pages (design 5.14). `rpId` is the app host whose
 * passkeys users hold; `origins` are the pages that run the ceremonies, the issuer origin in a
 * deployed environment, which the app host lists as a WebAuthn related origin.
 */
export type RelyingParty = { rpId: string; origins: readonly string[] };

export type UtsConfig = {
  environment: UtsEnvironment;
  endpoints: UtsEndpoints;
  jurisdiction: 'eu' | 'none';
  relyingParty: RelyingParty;
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
  /**
   * The public keys of the legacy bridge's subject tokens (`KiloBridgeJwksSchema`): one or two
   * Ed25519 JWKs as JSON, never a `KILO_WEB_CLIENT_JWKS` key. The bridge serves only where both
   * this and `LEGACY_BRIDGE_ENABLED` are set (src/bff/client-auth.ts).
   */
  KILO_WEB_BRIDGE_JWKS?: string;
  /** `true` turns on the `kilo-web` legacy bridge (src/bff/token.ts); anything else keeps it off. */
  LEGACY_BRIDGE_ENABLED?: string;
} & SignInEnv;

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
