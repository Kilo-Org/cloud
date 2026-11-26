import type { UtsOAuthProvider } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { UtsConfig } from '../../env';
import {
  DevEndpointsSchema,
  type DevEndpoints,
  type ProviderSpec,
  WORKOS_ENDPOINTS,
  type WorkosEndpoints,
  specWithEndpoints,
} from './specs';

/**
 * Sign-in configuration from the Worker's vars and secrets (names only here; the values are set
 * per environment, README "Sign-in providers"). A provider is offered only when every value it
 * needs is set. A provider with some values set and others missing is `misconfigured`: it is not
 * offered, and its routes answer 500, a deploy error that no retry fixes.
 *
 * Vars (plain): `SIGNIN_<PROVIDER>_CLIENT_ID`, `SIGNIN_APPLE_TEAM_ID`, `SIGNIN_APPLE_KEY_ID`,
 * `SIGNIN_ANTHROPIC_ASSERTION_{AUDIENCE,ISSUER,SUBJECT,KEY_ID}`, `SIGNIN_WORKOS_CLIENT_ID`.
 * Secrets: `SIGNIN_<PROVIDER>_CLIENT_SECRET`, `SIGNIN_APPLE_PRIVATE_KEY`,
 * `SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY`, `SIGNIN_WORKOS_API_KEY`, `SIGNIN_EMAIL_HASH_KEY`.
 * Development only: `SIGNIN_DEV_ENDPOINTS`, local stand-ins for provider endpoints.
 */

/** The client id var of each provider. */
const CLIENT_ID_VARS = {
  google: 'SIGNIN_GOOGLE_CLIENT_ID',
  openai: 'SIGNIN_OPENAI_CLIENT_ID',
  anthropic: 'SIGNIN_ANTHROPIC_CLIENT_ID',
  anaconda: 'SIGNIN_ANACONDA_CLIENT_ID',
  apple: 'SIGNIN_APPLE_CLIENT_ID',
  github: 'SIGNIN_GITHUB_CLIENT_ID',
  gitlab: 'SIGNIN_GITLAB_CLIENT_ID',
  discord: 'SIGNIN_DISCORD_CLIENT_ID',
  linkedin: 'SIGNIN_LINKEDIN_CLIENT_ID',
} as const satisfies Record<UtsOAuthProvider, string>;

/** The client secret of each provider that authenticates with one. */
const CLIENT_SECRET_VARS = {
  google: 'SIGNIN_GOOGLE_CLIENT_SECRET',
  openai: 'SIGNIN_OPENAI_CLIENT_SECRET',
  anaconda: 'SIGNIN_ANACONDA_CLIENT_SECRET',
  github: 'SIGNIN_GITHUB_CLIENT_SECRET',
  gitlab: 'SIGNIN_GITLAB_CLIENT_SECRET',
  discord: 'SIGNIN_DISCORD_CLIENT_SECRET',
  linkedin: 'SIGNIN_LINKEDIN_CLIENT_SECRET',
} as const satisfies Partial<Record<UtsOAuthProvider, string>>;

const OTHER_VAR_NAMES = [
  'SIGNIN_APPLE_TEAM_ID',
  'SIGNIN_APPLE_KEY_ID',
  'SIGNIN_APPLE_PRIVATE_KEY',
  'SIGNIN_ANTHROPIC_ASSERTION_AUDIENCE',
  'SIGNIN_ANTHROPIC_ASSERTION_ISSUER',
  'SIGNIN_ANTHROPIC_ASSERTION_SUBJECT',
  'SIGNIN_ANTHROPIC_ASSERTION_KEY_ID',
  'SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY',
  'SIGNIN_WORKOS_CLIENT_ID',
  'SIGNIN_WORKOS_API_KEY',
  'SIGNIN_EMAIL_HASH_KEY',
  'SIGNIN_DEV_ENDPOINTS',
] as const;

export type SignInVarName =
  | (typeof CLIENT_ID_VARS)[keyof typeof CLIENT_ID_VARS]
  | (typeof CLIENT_SECRET_VARS)[keyof typeof CLIENT_SECRET_VARS]
  | (typeof OTHER_VAR_NAMES)[number];
export type SignInEnv = Partial<Record<SignInVarName, string>>;

/** How UTS authenticates to a provider's token endpoint. */
export type ClientCredentials =
  | { kind: 'secret'; clientId: string; clientSecret: string }
  /** Sign in with Apple: the services id, team, key id and the P-256 key in PKCS #8 PEM. */
  | { kind: 'apple'; clientId: string; teamId: string; keyId: string; privateKeyPem: string }
  /** Claude: the client assertion's audience, issuer, subject, key id and P-256 key. */
  | {
      kind: 'assertion';
      clientId: string;
      audience: string;
      issuer: string;
      subject: string;
      keyId: string;
      privateKeyPem: string;
    };

export type Configured<Value> =
  | { status: 'off' }
  | { status: 'misconfigured'; missing: readonly string[] }
  | ({ status: 'on' } & Value);

export type ProviderConfig = Configured<{
  provider: UtsOAuthProvider;
  spec: ProviderSpec;
  credentials: ClientCredentials;
}>;
export type SsoConfig = Configured<{
  clientId: string;
  apiKey: string;
  endpoints: WorkosEndpoints;
}>;
/** The email sign-in's HMAC key, 32 random bytes; the mail port is wired separately. */
export type EmailHashKey = Configured<{ hashKey: Uint8Array }>;

export type SignInConfig = {
  providers: Readonly<Record<UtsOAuthProvider, ProviderConfig>>;
  sso: SsoConfig;
  emailHashKey: EmailHashKey;
};

const ValueSchema = z.string().trim().min(1);

/** `on` when every name has a value, `off` when none has, else `misconfigured`. */
function configured<Names extends string, Value>(
  env: SignInEnv,
  names: readonly (Names & SignInVarName)[],
  build: (values: Record<Names, string>) => Value
): Configured<Value> {
  const values: Partial<Record<Names, string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = ValueSchema.safeParse(env[name]);
    if (value.success) values[name] = value.data;
    else missing.push(name);
  }
  if (missing.length === names.length) return { status: 'off' };
  if (missing.length > 0) return { status: 'misconfigured', missing };
  // Every name was checked above, so `values` holds each of them.
  return { status: 'on', ...build(values as Record<Names, string>) };
}

function credentialsOf(
  provider: UtsOAuthProvider,
  env: SignInEnv
): Configured<{
  credentials: ClientCredentials;
}> {
  if (provider === 'apple') {
    return configured(
      env,
      [
        'SIGNIN_APPLE_CLIENT_ID',
        'SIGNIN_APPLE_TEAM_ID',
        'SIGNIN_APPLE_KEY_ID',
        'SIGNIN_APPLE_PRIVATE_KEY',
      ],
      values => ({
        credentials: {
          kind: 'apple',
          clientId: values.SIGNIN_APPLE_CLIENT_ID,
          teamId: values.SIGNIN_APPLE_TEAM_ID,
          keyId: values.SIGNIN_APPLE_KEY_ID,
          privateKeyPem: values.SIGNIN_APPLE_PRIVATE_KEY,
        },
      })
    );
  }
  if (provider === 'anthropic') {
    return configured(
      env,
      [
        'SIGNIN_ANTHROPIC_CLIENT_ID',
        'SIGNIN_ANTHROPIC_ASSERTION_AUDIENCE',
        'SIGNIN_ANTHROPIC_ASSERTION_ISSUER',
        'SIGNIN_ANTHROPIC_ASSERTION_SUBJECT',
        'SIGNIN_ANTHROPIC_ASSERTION_KEY_ID',
        'SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY',
      ],
      values => ({
        credentials: {
          kind: 'assertion',
          clientId: values.SIGNIN_ANTHROPIC_CLIENT_ID,
          audience: values.SIGNIN_ANTHROPIC_ASSERTION_AUDIENCE,
          issuer: values.SIGNIN_ANTHROPIC_ASSERTION_ISSUER,
          subject: values.SIGNIN_ANTHROPIC_ASSERTION_SUBJECT,
          keyId: values.SIGNIN_ANTHROPIC_ASSERTION_KEY_ID,
          privateKeyPem: values.SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY,
        },
      })
    );
  }
  const clientId = CLIENT_ID_VARS[provider];
  const clientSecret = CLIENT_SECRET_VARS[provider];
  return configured(env, [clientId, clientSecret], values => ({
    credentials: {
      kind: 'secret',
      clientId: values[clientId],
      clientSecret: values[clientSecret],
    },
  }));
}

const HashKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, '32 bytes in base64url')
  .transform(value => new Uint8Array(Buffer.from(value, 'base64url')));

/**
 * The development endpoint overrides: `none` when unset, `bad` when set outside development or not
 * valid, which makes every provider and SSO misconfigured rather than failing other routes.
 */
function devEndpoints(
  env: SignInEnv,
  config: UtsConfig
): { status: 'none' } | { status: 'set'; endpoints: DevEndpoints } | { status: 'bad' } {
  if (env.SIGNIN_DEV_ENDPOINTS === undefined) return { status: 'none' };
  if (config.environment !== 'development') return { status: 'bad' };
  let value: unknown;
  try {
    value = JSON.parse(env.SIGNIN_DEV_ENDPOINTS);
  } catch {
    return { status: 'bad' };
  }
  const parsed = DevEndpointsSchema.safeParse(value);
  return parsed.success ? { status: 'set', endpoints: parsed.data } : { status: 'bad' };
}

const DEV_ENDPOINTS_PROBLEM = { status: 'misconfigured', missing: ['SIGNIN_DEV_ENDPOINTS'] } as const;

/**
 * Reads the sign-in configuration. It never throws: a value that does not parse makes only its
 * method misconfigured, so a bad sign-in setting cannot fail the token or metadata routes.
 * `SIGNIN_DEV_ENDPOINTS` counts only in development; set anywhere else, or not valid, it makes
 * every provider and SSO misconfigured.
 */
export function readSignInConfig(env: SignInEnv, config: UtsConfig): SignInConfig {
  const dev = devEndpoints(env, config);
  const overrides = dev.status === 'set' ? dev.endpoints : null;
  const provider = (id: UtsOAuthProvider): ProviderConfig => {
    const credentials = credentialsOf(id, env);
    if (credentials.status !== 'on') return credentials;
    if (dev.status === 'bad') return DEV_ENDPOINTS_PROBLEM;
    return {
      status: 'on',
      provider: id,
      spec: specWithEndpoints(id, overrides),
      credentials: credentials.credentials,
    };
  };
  const providers: Record<UtsOAuthProvider, ProviderConfig> = {
    google: provider('google'),
    openai: provider('openai'),
    anthropic: provider('anthropic'),
    anaconda: provider('anaconda'),
    apple: provider('apple'),
    github: provider('github'),
    gitlab: provider('gitlab'),
    discord: provider('discord'),
    linkedin: provider('linkedin'),
  };
  const workos = configured(
    env,
    ['SIGNIN_WORKOS_CLIENT_ID', 'SIGNIN_WORKOS_API_KEY'],
    values => ({
      clientId: values.SIGNIN_WORKOS_CLIENT_ID,
      apiKey: values.SIGNIN_WORKOS_API_KEY,
      endpoints: overrides?.workos ?? WORKOS_ENDPOINTS,
    })
  );
  const sso: SsoConfig = workos.status === 'on' && dev.status === 'bad' ? DEV_ENDPOINTS_PROBLEM : workos;
  const rawKey = configured(env, ['SIGNIN_EMAIL_HASH_KEY'], values => ({
    key: values.SIGNIN_EMAIL_HASH_KEY,
  }));
  let emailHashKey: EmailHashKey;
  if (rawKey.status === 'on') {
    const key = HashKeySchema.safeParse(rawKey.key);
    emailHashKey = key.success
      ? { status: 'on', hashKey: key.data }
      : { status: 'misconfigured', missing: ['SIGNIN_EMAIL_HASH_KEY'] };
  } else {
    emailHashKey = rawKey;
  }
  return { providers, sso, emailHashKey };
}

const configs = new WeakMap<object, SignInConfig>();

/**
 * The sign-in configuration of one `env`, read once per isolate: an isolate keeps one `env`
 * object, so the token and metadata routes pay for no parse after the first request.
 */
export function signInConfigFor(env: SignInEnv, config: UtsConfig): SignInConfig {
  let settings = configs.get(env);
  if (settings === undefined) {
    settings = readSignInConfig(env, config);
    configs.set(env, settings);
  }
  return settings;
}

/** Logs a misconfigured sign-in method once per request that reaches it; names only. */
export function logMisconfigured(method: string, missing: readonly string[]): void {
  console.error(JSON.stringify({ event: 'uts.signin.misconfigured', method, missing }));
}
