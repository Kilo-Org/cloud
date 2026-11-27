import {
  SecretUnavailableError,
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';
import type { UtsConfig } from './env';

/**
 * Every runtime secret the sign-in, device grant, mail and attestation readers use, by its STS
 * bundle name (manager folder `/workloads/uts`, policy `services/sts/policy/uts.yaml`). The legacy
 * Worker secret of each name holds the `worker` source's copy. `UTS_HYPERDRIVE_SWITCH_TOKEN` is not
 * here: it has no Worker secret, and the rotation job always reads it from STS
 * (src/rotation/secrets.ts).
 */
export const UTS_SECRET_NAMES = [
  'DEVICE_USER_CODE_KEY',
  'SIGNIN_EMAIL_HASH_KEY',
  'SIGNIN_GOOGLE_CLIENT_SECRET',
  'SIGNIN_OPENAI_CLIENT_SECRET',
  'SIGNIN_ANACONDA_CLIENT_SECRET',
  'SIGNIN_GITHUB_CLIENT_SECRET',
  'SIGNIN_GITLAB_CLIENT_SECRET',
  'SIGNIN_DISCORD_CLIENT_SECRET',
  'SIGNIN_LINKEDIN_CLIENT_SECRET',
  'SIGNIN_APPLE_PRIVATE_KEY',
  'SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY',
  'SIGNIN_WORKOS_API_KEY',
  'UTS_MAILGUN_SENDING_KEY',
  'UTS_TURNSTILE_SECRET_KEY',
  'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY',
] as const;

export type UtsSecretName = (typeof UTS_SECRET_NAMES)[number];

const SECRET_NAMES: ReadonlySet<string> = new Set(UTS_SECRET_NAMES);

export function isUtsSecretName(name: string): name is UtsSecretName {
  return SECRET_NAMES.has(name);
}

/** The values one source holds; a name the source holds no value for is absent. */
export type UtsSecretValues = Readonly<Partial<Record<UtsSecretName, string>>>;

/**
 * `worker`: the legacy Worker secrets of the same names. `sts`: the UTS STS bundle over the `STS`
 * binding, which never falls back to the Worker secrets.
 */
export type SecretsSource = 'worker' | 'sts';

/**
 * What the readers get. `read`: the source answered; a name it holds no value for is absent, and
 * the method that needs it is `off` or `misconfigured` exactly as with an unset Worker secret. STS
 * refusing the `uts` workload, or a missing `STS` binding, reads as no values at all: a deploy or
 * policy error that no retry fixes. `unavailable`: STS gave no usable bundle (no copy yet, or the
 * held copy is past the 24 hour stale limit); the methods that need a secret answer 503 and a
 * retry may succeed.
 */
export type UtsSecrets =
  | { status: 'read'; source: SecretsSource; values: UtsSecretValues }
  | { status: 'unavailable' };

/**
 * The legacy Worker secrets (still bound for rollback) and the STS binding. Only `workerValues`
 * reads the legacy names, and only under the `worker` source.
 */
export type SecretsEnv = Partial<Record<UtsSecretName, string>> & { STS?: BundleBinding };

/** One bundle client per binding, so one bundle per isolate across requests and the rotation job. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

export function stsSecrets(binding: BundleBinding): Secrets {
  let client = stsClients.get(binding);
  if (client === undefined) {
    client = createWorkerSecrets(binding);
    stsClients.set(binding, client);
  }
  return client;
}

/** The `worker` source's values, read once per `env` (one per isolate). */
const workerCopies = new WeakMap<object, UtsSecretValues>();

function workerValues(env: SecretsEnv): UtsSecretValues {
  let values = workerCopies.get(env);
  if (values === undefined) {
    const read: Partial<Record<UtsSecretName, string>> = {};
    for (const name of UTS_SECRET_NAMES) {
      const value = env[name];
      if (value !== undefined) read[name] = value;
    }
    values = read;
    workerCopies.set(env, values);
    logRead({ source: 'worker', absent: UTS_SECRET_NAMES.filter(name => !(name in read)) });
  }
  return values;
}

/** The bundle version this isolate logged last; a new version or staleness logs again. */
let loggedBundle: string | null = null;

/**
 * One `uts.secrets.read` line per isolate for the `worker` source, and per bundle version and
 * staleness for `sts`, so the logs show which source every isolate reads. Names only.
 */
function logRead(fields: {
  source: SecretsSource;
  absent: readonly UtsSecretName[];
  stale?: boolean;
  fetched_at?: string;
}): void {
  console.log(JSON.stringify({ event: 'uts.secrets.read', ...fields }));
}

function logUnavailable(reason: string): void {
  console.error(JSON.stringify({ event: 'uts.secrets.unavailable', source: 'sts', reason }));
}

const NO_VALUES: UtsSecretValues = {};

async function bundleValues(
  client: Secrets,
  ctx: SecretsExecutionContext
): Promise<{ values: UtsSecretValues; absent: UtsSecretName[] }> {
  const values: Partial<Record<UtsSecretName, string>> = {};
  const absent: UtsSecretName[] = [];
  for (const name of UTS_SECRET_NAMES) {
    try {
      values[name] = await client.get(name, ctx);
    } catch (error) {
      // A name the policy does not grant or the manager holds no value for is an unset secret.
      if (
        error instanceof SecretUnavailableError &&
        (error.reason === 'missing' || error.reason === 'not_granted')
      ) {
        absent.push(name);
      } else {
        throw error;
      }
    }
  }
  return { values, absent };
}

/**
 * Reads every UTS secret from the configured source. `ctx` belongs to the invocation doing the read:
 * a bundle revalidation it starts runs under that invocation's `waitUntil`. The `sts` source keeps
 * the client's rules: one bundle per isolate, a background revalidation after 4 minutes, a wait for
 * the bundle only on a cold isolate or past the 5 minute cache life, and the held copy served for up
 * to 24 hours while STS fails.
 */
export async function readUtsSecrets(
  env: SecretsEnv,
  config: Pick<UtsConfig, 'secretsSource'>,
  ctx: SecretsExecutionContext
): Promise<UtsSecrets> {
  if (config.secretsSource === 'worker') {
    return { status: 'read', source: 'worker', values: workerValues(env) };
  }
  if (env.STS === undefined) {
    logUnavailable('not_bound');
    return { status: 'read', source: 'sts', values: NO_VALUES };
  }
  const client = stsSecrets(env.STS);
  try {
    const snapshot = await client.snapshot(ctx);
    const { values, absent } = await bundleValues(client, ctx);
    const version = `${snapshot.etag}|${String(snapshot.stale)}`;
    if (loggedBundle !== version) {
      loggedBundle = version;
      logRead({ source: 'sts', absent, stale: snapshot.stale, fetched_at: snapshot.fetchedAt });
    }
    return { status: 'read', source: 'sts', values };
  } catch (error) {
    if (!(error instanceof SecretUnavailableError)) throw error;
    logUnavailable(error.reason);
    return error.retryable
      ? { status: 'unavailable' }
      : { status: 'read', source: 'sts', values: NO_VALUES };
  }
}

/** True when both reads hold the same values, so a reader parsed from one fits the other. */
export function sameSecrets(a: UtsSecrets, b: UtsSecrets): boolean {
  if (a.status === 'unavailable' || b.status === 'unavailable') return a.status === b.status;
  if (a.values === b.values) return true;
  return UTS_SECRET_NAMES.every(name => a.values[name] === b.values[name]);
}

/**
 * The secrets of one request, read on first use and shared by every later use in that request, so
 * a route that needs no secret never waits for STS.
 */
export function requestSecrets(
  env: SecretsEnv,
  config: Pick<UtsConfig, 'secretsSource'>,
  ctx: SecretsExecutionContext
): () => Promise<UtsSecrets> {
  let read: Promise<UtsSecrets> | null = null;
  return () => {
    read ??= readUtsSecrets(env, config, ctx);
    return read;
  };
}
