import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';

/**
 * Every secret this Worker reads, by its STS bundle name (design 4.7: canonical names, no
 * environment suffix) mapped to the binding it reads today. `NEXTAUTH_SECRET` and
 * `INTERNAL_API_SECRET` resolve from `/shared` — the internal API secret under its plain name even
 * though the binding it reads today is `INTERNAL_API_SECRET_PROD`; `SESSION_SYNC_SECRET` resolves
 * from `/workloads/session-sync`. services/sts/policy/session-sync.yaml grants them.
 */
const BINDINGS = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  SESSION_SYNC_SECRET: 'SESSION_SYNC_SECRET',
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET_PROD',
} as const;

export type SessionSyncSecretName = keyof typeof BINDINGS;

type BindingName = (typeof BINDINGS)[SessionSyncSecretName];

/**
 * Names not held for the isolate. `INTERNAL_API_SECRET` authorizes the destructive user-erasure
 * route, and it was read on every request before this switch, so under `secrets-store` a rotated
 * value takes effect on the next request instead of when every isolate has recycled. The `sts`
 * source cannot offer that: the value arrives in the isolate's bundle, so a rotation reaches it
 * within the bundle window (revalidate 240 s, cache 300 s, and up to the 24 h stale limit while STS
 * is unreachable).
 */
const UNCACHED: Partial<Record<SessionSyncSecretName, true>> = { INTERNAL_API_SECRET: true };

/** A Secrets Store binding, or the plain Worker secret, which arrives as its own string. */
type LegacySecretValue = string | { get(): Promise<string> };

/**
 * `SECRETS_SOURCE` selects where every read goes: `secrets-store` reads the binding the deployment
 * holds today, `sts` reads the bundle over the `STS` service binding. An absent value means
 * `secrets-store`, so merging this path changes nothing until `SECRETS_SOURCE` is set to `sts`.
 * The `sts` source never falls back to the legacy binding: a failed bundle read fails the read.
 */
export type SessionSyncSecretsEnv = Partial<Record<BindingName, LegacySecretValue>> & {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

export type SecretsSource = 'secrets-store' | 'sts';

/** Fails closed: an unrecognised value refuses every read instead of guessing a source. */
export function secretsSource(env: Pick<SessionSyncSecretsEnv, 'SECRETS_SOURCE'>): SecretsSource {
  const source = env.SECRETS_SOURCE ?? 'secrets-store';
  if (source !== 'secrets-store' && source !== 'sts') {
    throw new Error('SECRETS_SOURCE must be either "secrets-store" or "sts"');
  }
  return source;
}

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * One resolved value per binding per isolate, keyed by the binding itself: the `secrets-store`
 * source reads each Secrets Store item once and returns the held value on every later read in the
 * isolate. A value is held only when the caller would accept it, so a failed read, an empty value
 * and a value under the caller's minimum are all retried on the next read instead of being pinned
 * for the isolate's lifetime. The `sts` source needs no cache of its own: the client holds the
 * bundle.
 */
const resolvedValues = new WeakMap<object, string>();

/** Whether a value can be held: empty and too-short values are refused by the caller anyway. */
function holdable(value: string, minBytes: number | undefined): boolean {
  if (value === '') return false;
  if (minBytes === undefined) return true;
  return new TextEncoder().encode(value).byteLength >= minBytes;
}

async function legacyValue(value: LegacySecretValue, minBytes?: number): Promise<string> {
  if (typeof value === 'string') return value;
  const held = resolvedValues.get(value);
  if (held !== undefined) return held;
  const resolved = await value.get();
  if (!holdable(resolved, minBytes)) return resolved;
  resolvedValues.set(value, resolved);
  return resolved;
}

/**
 * Reads one secret from the selected source and returns it as stored, empty included, so every
 * caller keeps its own empty-value handling. `ctx` belongs to the invocation doing the read (the
 * Worker request, queue batch or Durable Object): a bundle revalidation it starts runs under that
 * invocation's `waitUntil`. `minBytes` is the caller's own minimum for this read: it never changes
 * the returned value, only whether the `secrets-store` source holds it for the isolate.
 */
export async function readSessionSyncSecret(
  env: SessionSyncSecretsEnv,
  name: SessionSyncSecretName,
  ctx?: SecretsExecutionContext,
  minBytes?: number
): Promise<string> {
  if (secretsSource(env) === 'sts') {
    const binding = env.STS;
    if (binding === undefined) {
      throw new Error('SECRETS_SOURCE is "sts" but the STS service binding is missing');
    }
    let client = stsClients.get(binding);
    if (client === undefined) {
      client = createWorkerSecrets(binding);
      stsClients.set(binding, client);
    }
    return client.get(name, ctx);
  }
  const bindingName = BINDINGS[name];
  const value = env[bindingName];
  if (value === undefined) {
    throw new Error(`${bindingName} is not configured`);
  }
  if (UNCACHED[name] === true) return typeof value === 'string' ? value : value.get();
  return legacyValue(value, minBytes);
}
