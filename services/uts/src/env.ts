import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { UtsKeySetDO } from './dos/UtsKeySetDO';
import type { UtsSignerDO } from './dos/UtsSignerDO';
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
 */
const EnvVarsSchema = z
  .object({
    UTS_ENVIRONMENT: UtsEnvironmentSchema,
    DO_JURISDICTION: z.enum(['eu', 'none']),
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
    vars =>
      vars.UTS_ENVIRONMENT === 'development'
        ? vars.WEBAUTHN_RP_ID === 'localhost' &&
          vars.WEBAUTHN_ORIGINS.every(origin => new URL(origin).hostname === 'localhost')
        : vars.WEBAUTHN_ORIGINS.every(origin => origin.startsWith('https://')),
    'WebAuthn runs on https origins, and on localhost only in development'
  );

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
  UTS_SIGNER_DO: DurableObjectNamespace<UtsSignerDO>;
  UTS_KEY_SET_DO: DurableObjectNamespace<UtsKeySetDO>;
  /**
   * The identity store's primary Hyperdrive config, bound once the environment's identity store is
   * provisioned. `identityStoreBinding` (src/grants/binding.ts) is the only reader.
   */
  IDENTITY_STORE?: Hyperdrive;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_ORIGINS: string;
  /**
   * The HMAC key of RFC 8628 user codes, 32 bytes in base64url, a Worker secret. The device grant
   * is served only where it is set (src/signin/device/user-code.ts).
   */
  DEVICE_USER_CODE_KEY?: string;
} & SignInEnv;

/** The mint Worker's deployed name in each environment. */
export const MINT_DEPLOYMENTS: Readonly<Record<UtsEnvironment, string>> = {
  production: 'uts',
  staging: 'uts-staging',
  development: 'uts-local',
};

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
