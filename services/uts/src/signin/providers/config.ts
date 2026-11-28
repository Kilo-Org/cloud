import type { UtsOAuthProvider } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { UtsConfig } from '../../env';
import type { MailgunConfig } from '../../notices/transports';
import { type UtsSecretName, type UtsSecrets, isUtsSecretName, sameSecrets } from '../../secrets';
import { isMailDomain, isMailLocalPart } from '../email/address';
import {
  DevEndpointsSchema,
  type DevEndpoints,
  type ProviderSpec,
  WORKOS_ENDPOINTS,
  type WorkosEndpoints,
  specWithEndpoints,
} from './specs';

/**
 * Sign-in configuration from the Worker's vars and the runtime secrets (names only here; the values
 * are set per environment, README "Sign-in providers"). The secrets come from the source
 * `SECRETS_SOURCE` selects (src/secrets.ts), never from the Worker env directly. A provider is
 * offered only when every value it needs is set. A provider with some values set and others
 * missing is `misconfigured`: it is not offered, and its routes answer 500, a deploy error that no
 * retry fixes. A provider whose vars are set while STS gives no usable bundle is `unavailable`: it
 * is not offered, and its routes answer 503, which a retry can fix. A provider with none of its
 * vars set stays `off` whatever the bundle's state.
 *
 * Vars (plain): `SIGNIN_<PROVIDER>_CLIENT_ID`, `SIGNIN_APPLE_TEAM_ID`, `SIGNIN_APPLE_KEY_ID`,
 * `SIGNIN_ANTHROPIC_ASSERTION_{AUDIENCE,ISSUER,SUBJECT,KEY_ID}`, `SIGNIN_WORKOS_CLIENT_ID`,
 * `UTS_MAILGUN_DOMAIN`, `UTS_MAIL_FROM`, `UTS_TURNSTILE_SITE_KEY`, `UTS_MAIL_ALLOWED_RECIPIENTS`.
 * Secrets: `SIGNIN_<PROVIDER>_CLIENT_SECRET`, `SIGNIN_APPLE_PRIVATE_KEY`,
 * `SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY`, `SIGNIN_WORKOS_API_KEY`, `SIGNIN_EMAIL_HASH_KEY`,
 * `UTS_MAILGUN_SENDING_KEY`, `UTS_TURNSTILE_SECRET_KEY`.
 * Development only: `SIGNIN_DEV_ENDPOINTS`, local stand-ins for provider, Mailgun and Turnstile
 * endpoints.
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
} as const satisfies Partial<Record<UtsOAuthProvider, UtsSecretName>>;

const OTHER_VAR_NAMES = [
  'SIGNIN_APPLE_TEAM_ID',
  'SIGNIN_APPLE_KEY_ID',
  'SIGNIN_ANTHROPIC_ASSERTION_AUDIENCE',
  'SIGNIN_ANTHROPIC_ASSERTION_ISSUER',
  'SIGNIN_ANTHROPIC_ASSERTION_SUBJECT',
  'SIGNIN_ANTHROPIC_ASSERTION_KEY_ID',
  'SIGNIN_WORKOS_CLIENT_ID',
  'UTS_MAILGUN_DOMAIN',
  'UTS_MAIL_FROM',
  'UTS_TURNSTILE_SITE_KEY',
  'UTS_MAIL_ALLOWED_RECIPIENTS',
  'SIGNIN_DEV_ENDPOINTS',
] as const;

export type SignInVarName =
  | (typeof CLIENT_ID_VARS)[keyof typeof CLIENT_ID_VARS]
  | (typeof OTHER_VAR_NAMES)[number];
export type SignInEnv = Partial<Record<SignInVarName, string>>;

/** What the readers see: the plain vars from the Worker env and the secrets of one read. */
export type SignInInput = { vars: SignInEnv; secrets: UtsSecrets };

type SignInName = SignInVarName | UtsSecretName;

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

/**
 * `off`: none of the method's plain vars is set, whatever its secrets hold. `on`: every value is
 * set and valid. `misconfigured`: the names of the values that are missing or invalid (never a
 * value). `unavailable`: the method's vars are set, or it needs only secrets, and STS gave no
 * usable bundle.
 */
export type Configured<Value> =
  | { status: 'off' }
  | { status: 'misconfigured'; missing: readonly string[] }
  | { status: 'unavailable' }
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
/** The email sign-in's HMAC key, 32 random bytes; the mail sender is configured separately. */
export type EmailHashKey = Configured<{ hashKey: Uint8Array }>;

/**
 * Who may receive email. Production sends to any address; staging and development send only to
 * the addresses and domains of `UTS_MAIL_ALLOWED_RECIPIENTS`, because their sign-in form takes
 * any typed address and their accounts may hold real ones.
 */
export type RecipientRule =
  | { kind: 'any' }
  | { kind: 'allow_list'; addresses: ReadonlySet<string>; domains: ReadonlySet<string> };

/** Cloudflare Turnstile on the email start form: the widget's site key and its secret. */
export type TurnstileSettings = { siteKey: string; secretKey: string; verifyUrl: string };

/**
 * The mail sender (Mailgun) and the Turnstile check that must guard any form that makes it send.
 * One setting: mail never leaves without the Turnstile check, so neither is on without the other.
 */
export type MailSettings = Configured<{
  mailgun: MailgunConfig;
  turnstile: TurnstileSettings;
  recipients: RecipientRule;
}>;

export type SignInConfig = {
  providers: Readonly<Record<UtsOAuthProvider, ProviderConfig>>;
  sso: SsoConfig;
  emailHashKey: EmailHashKey;
  mail: MailSettings;
};

/** Mailgun's API host of the region that holds the sending domain (US). */
export const MAILGUN_API = 'https://api.mailgun.net';
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const ValueSchema = z.string().trim().min(1);

const UNAVAILABLE = { status: 'unavailable' } as const;

const UNREAD = Symbol('unread');

/** A var from the Worker env; a secret from the read, or `UNREAD` when STS gave no bundle. */
function rawValue(input: SignInInput, name: SignInName): string | undefined | typeof UNREAD {
  if (!isUtsSecretName(name)) return input.vars[name];
  return input.secrets.status === 'read' ? input.secrets.values[name] : UNREAD;
}

/**
 * `off` when every plain var of the method is unset, whatever the secrets hold: the vars are the
 * switch, so a bundle that delivers every granted secret cannot make a method the environment has
 * not turned on `misconfigured` (README "Runtime secrets", "Methods with none of their vars set").
 * A method with only secrets (the email hash key) has no such switch: it follows its secret, `on`
 * when the read delivers it, `off` when the read holds no value for it. Otherwise `on` when every
 * name has a value, else `misconfigured`. With the secrets unread: `misconfigured` when the read
 * names alone already disagree, `off` when none of the method's plain vars is set, else
 * `unavailable`.
 */
function configured<Names extends string, Value>(
  input: SignInInput,
  names: readonly (Names & SignInName)[],
  build: (values: Record<Names, string>) => Value
): Configured<Value> {
  const values: Partial<Record<Names, string>> = {};
  const missing: string[] = [];
  let unread = 0;
  let plainVars = 0;
  let plainSet = 0;
  for (const name of names) {
    const secret = isUtsSecretName(name);
    if (!secret) plainVars += 1;
    const raw = rawValue(input, name);
    if (raw === UNREAD) {
      unread += 1;
      continue;
    }
    const value = ValueSchema.safeParse(raw);
    if (value.success) {
      values[name] = value.data;
      if (!secret) plainSet += 1;
    } else missing.push(name);
  }
  if (plainVars > 0 && plainSet === 0) return { status: 'off' };
  const read = names.length - unread;
  if (missing.length > 0 && missing.length < read) return { status: 'misconfigured', missing };
  if (unread > 0) return UNAVAILABLE;
  if (missing.length === names.length) return { status: 'off' };
  // Every name was checked above, so `values` holds each of them.
  return { status: 'on', ...build(values as Record<Names, string>) };
}

function credentialsOf(
  provider: UtsOAuthProvider,
  input: SignInInput
): Configured<{
  credentials: ClientCredentials;
}> {
  if (provider === 'apple') {
    return configured(
      input,
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
      input,
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
  return configured(input, [clientId, clientSecret], values => ({
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

const DomainSchema = z.string().refine(isMailDomain, 'a lower-case domain');

/** `Name <local@domain>` or `local@domain`; no character that could end a header line. */
const FROM =
  /^(?:[A-Za-z0-9][A-Za-z0-9 .'-]{0,63} <([a-z0-9._+-]{1,64})@([^@<>\s]+)>|([a-z0-9._+-]{1,64})@([^@<>\s]+))$/;

/** The sender's domain, or null when `from` is not a sender this code accepts. */
function senderDomain(from: string): string | null {
  const match = FROM.exec(from);
  if (match === null) return null;
  const domain = match[2] ?? match[4];
  return DomainSchema.safeParse(domain).success ? domain : null;
}

/** A Turnstile site key: printable token characters only, as it lands in an HTML attribute. */
const SiteKeySchema = z.string().regex(/^[0-9A-Za-z_-]{1,128}$/);

/**
 * `UTS_MAIL_ALLOWED_RECIPIENTS`: comma-separated entries, each an exact address
 * (`person@example.com`) or a whole domain (`@example.com`, that domain only, no subdomain).
 */
function recipientRule(value: string): RecipientRule | null {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of value.split(',')) {
    const entry = raw.trim().toLowerCase();
    const at = entry.lastIndexOf('@');
    if (at < 0 || !DomainSchema.safeParse(entry.slice(at + 1)).success) return null;
    if (at === 0) domains.add(entry.slice(1));
    else if (isMailLocalPart(entry.slice(0, at))) addresses.add(entry);
    else return null;
  }
  return addresses.size + domains.size === 0 ? null : { kind: 'allow_list', addresses, domains };
}

/** True when the rule lets UTS send to this address. */
export function recipientAllowed(rule: RecipientRule, address: string): boolean {
  if (rule.kind === 'any') return true;
  const email = address.toLowerCase();
  return rule.addresses.has(email) || rule.domains.has(email.slice(email.lastIndexOf('@') + 1));
}

const ALLOWED_RECIPIENTS_PROBLEM = {
  status: 'misconfigured',
  missing: ['UTS_MAIL_ALLOWED_RECIPIENTS'],
} as const;

/** The mail vars that switch the mail settings on (`readMailSettings`). */
const MAIL_SWITCH_VARS = ['UTS_MAILGUN_DOMAIN', 'UTS_MAIL_FROM', 'UTS_TURNSTILE_SITE_KEY'] as const;

/**
 * The mail settings: `on` only when the Mailgun domain and sender and the Turnstile site key (vars)
 * and the Mailgun sending key and Turnstile secret (secrets) are all set and valid. The vars are
 * the switch: with none of them set the settings are `off` even when the secrets are set, so the
 * secrets can be put first and the deploy that adds the vars turns mail on; with some vars set and
 * anything missing they are `misconfigured`; with the vars set and no usable bundle they are
 * `unavailable`. Outside production `UTS_MAIL_ALLOWED_RECIPIENTS` must also be set and valid;
 * production must not set it, so a test restriction cannot reach production unnoticed.
 */
function readMailSettings(
  input: SignInInput,
  config: UtsConfig,
  dev: DevEndpointsSetting
): MailSettings {
  const core = configured(input, MAIL_SWITCH_VARS, values => values);
  if (core.status !== 'on') return core;
  if (input.secrets.status === 'unavailable') return UNAVAILABLE;
  const apiKey = ValueSchema.safeParse(input.secrets.values.UTS_MAILGUN_SENDING_KEY);
  const secretKey = ValueSchema.safeParse(input.secrets.values.UTS_TURNSTILE_SECRET_KEY);
  if (!apiKey.success || !secretKey.success) {
    return {
      status: 'misconfigured',
      missing: [
        ...(apiKey.success ? [] : ['UTS_MAILGUN_SENDING_KEY']),
        ...(secretKey.success ? [] : ['UTS_TURNSTILE_SECRET_KEY']),
      ],
    };
  }
  if (dev.status === 'bad') return DEV_ENDPOINTS_PROBLEM;
  const domain = DomainSchema.safeParse(core.UTS_MAILGUN_DOMAIN);
  if (!domain.success) return { status: 'misconfigured', missing: ['UTS_MAILGUN_DOMAIN'] };
  if (senderDomain(core.UTS_MAIL_FROM) !== domain.data) {
    // The sender must sit on the sending domain, or SPF and DKIM alignment (DMARC) fail.
    return { status: 'misconfigured', missing: ['UTS_MAIL_FROM'] };
  }
  if (!SiteKeySchema.safeParse(core.UTS_TURNSTILE_SITE_KEY).success) {
    return { status: 'misconfigured', missing: ['UTS_TURNSTILE_SITE_KEY'] };
  }
  const allowList = ValueSchema.safeParse(input.vars.UTS_MAIL_ALLOWED_RECIPIENTS);
  let recipients: RecipientRule;
  if (config.environment === 'production') {
    if (allowList.success) return ALLOWED_RECIPIENTS_PROBLEM;
    recipients = { kind: 'any' };
  } else {
    const rule = allowList.success ? recipientRule(allowList.data) : null;
    if (rule === null) return ALLOWED_RECIPIENTS_PROBLEM;
    recipients = rule;
  }
  const endpoints = dev.status === 'set' ? dev.endpoints.mail : undefined;
  return {
    status: 'on',
    mailgun: {
      baseUrl: endpoints?.mailgun ?? MAILGUN_API,
      domain: domain.data,
      from: core.UTS_MAIL_FROM,
      apiKey: apiKey.data,
    },
    turnstile: {
      siteKey: core.UTS_TURNSTILE_SITE_KEY,
      secretKey: secretKey.data,
      verifyUrl: endpoints?.turnstile ?? TURNSTILE_SITEVERIFY_URL,
    },
    recipients,
  };
}

/** `SIGNIN_DEV_ENDPOINTS` as read: unset, a valid development override, or a deploy error. */
type DevEndpointsSetting =
  | { status: 'none' }
  | { status: 'set'; endpoints: DevEndpoints }
  | { status: 'bad' };

/**
 * The development endpoint overrides: `none` when unset, `bad` when set outside development or not
 * valid, which makes every provider, SSO and the mail sender misconfigured rather than failing
 * other routes.
 */
function devEndpoints(env: SignInEnv, config: UtsConfig): DevEndpointsSetting {
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

const DEV_ENDPOINTS_PROBLEM = {
  status: 'misconfigured',
  missing: ['SIGNIN_DEV_ENDPOINTS'],
} as const;

/**
 * Reads the sign-in configuration. It never throws: a value that does not parse makes only its
 * method misconfigured, so a bad sign-in setting cannot fail the token or metadata routes.
 * `SIGNIN_DEV_ENDPOINTS` counts only in development; set anywhere else, or not valid, it makes
 * every provider, SSO and the mail sender misconfigured.
 */
export function readSignInConfig(input: SignInInput, config: UtsConfig): SignInConfig {
  const dev = devEndpoints(input.vars, config);
  const overrides = dev.status === 'set' ? dev.endpoints : null;
  const provider = (id: UtsOAuthProvider): ProviderConfig => {
    const credentials = credentialsOf(id, input);
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
    input,
    ['SIGNIN_WORKOS_CLIENT_ID', 'SIGNIN_WORKOS_API_KEY'],
    values => ({
      clientId: values.SIGNIN_WORKOS_CLIENT_ID,
      apiKey: values.SIGNIN_WORKOS_API_KEY,
      endpoints: overrides?.workos ?? WORKOS_ENDPOINTS,
    })
  );
  const sso: SsoConfig =
    workos.status === 'on' && dev.status === 'bad' ? DEV_ENDPOINTS_PROBLEM : workos;
  const rawKey = configured(input, ['SIGNIN_EMAIL_HASH_KEY'], values => ({
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
  return { providers, sso, emailHashKey, mail: readMailSettings(input, config, dev) };
}

/** The last parse per `env`, with the secrets it came from. */
const configs = new WeakMap<object, { secrets: UtsSecrets; settings: SignInConfig }>();

/**
 * The sign-in configuration of one `env` and one secrets read. It is parsed again only when the
 * secrets change: an isolate keeps one `env` object, and the `worker` source hands it the same
 * values object, while the `sts` source changes them only when a revalidation brings a new bundle.
 */
export function signInConfigFor(
  env: SignInEnv,
  secrets: UtsSecrets,
  config: UtsConfig
): SignInConfig {
  const held = configs.get(env);
  if (held !== undefined && sameSecrets(held.secrets, secrets)) return held.settings;
  const settings = readSignInConfig({ vars: env, secrets }, config);
  configs.set(env, { secrets, settings });
  return settings;
}

/**
 * The mail settings for the notice email. The three mail vars are the switch, so with none of them
 * set the settings are `off` and the secrets are not read: the minute cron and the account API's
 * notice then never call STS in an environment without mail.
 */
export async function mailSettingsFor(
  env: SignInEnv,
  secrets: () => Promise<UtsSecrets>,
  config: UtsConfig
): Promise<MailSettings> {
  if (!MAIL_SWITCH_VARS.some(name => ValueSchema.safeParse(env[name]).success)) {
    return { status: 'off' };
  }
  return signInConfigFor(env, await secrets(), config).mail;
}

/** Logs a misconfigured sign-in method once per request that reaches it; names only. */
export function logMisconfigured(method: string, missing: readonly string[]): void {
  console.error(JSON.stringify({ event: 'uts.signin.misconfigured', method, missing }));
}
