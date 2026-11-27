import {
  createWorkerSecrets,
  SecretUnavailableError,
  type BundleBinding,
  type SecretUnavailableReason,
  type Secrets,
} from '@kilocode/secrets-client';
import { z } from 'zod';

/**
 * The one secret Security Sync reads, by its manager and STS bundle name. STS resolves it from
 * `/workloads/cloudflare-security-sync` first, then `/shared` (design 4.2). The `secrets-store`
 * source reads the `INTERNAL_API_SECRET` Secrets Store binding instead, at each call site.
 */
const INTERNAL_API_SECRET = 'INTERNAL_API_SECRET';

const SecretsSourceSchema = z.enum(['secrets-store', 'sts']);

export type SecuritySyncSecretsSource = z.infer<typeof SecretsSourceSchema>;

/**
 * `SECRETS_SOURCE` selects where every internal API secret read goes: `secrets-store` (or no
 * value) reads the Secrets Store binding exactly as before, `sts` reads the bundle over the `STS`
 * service binding and never falls back to the Secrets Store.
 */
export type SecuritySyncSecretsEnv = {
  SECRETS_SOURCE?: string;
  STS?: BundleBinding;
};

/** Why an STS read gave no value. Every value is fixed here; none comes from an error. */
export type StsReadFailure =
  | 'binding_missing'
  | 'missing'
  | 'not_granted'
  | 'denied'
  | 'unavailable'
  | 'read_failed';

export type StsReadResult = { ok: true; value: string } | { ok: false; reason: StsReadFailure };

const CLIENT_REASONS: Record<SecretUnavailableReason, StsReadFailure> = {
  missing: 'missing',
  not_granted: 'not_granted',
  denied: 'denied',
  unavailable: 'unavailable',
};

/** One client per binding keeps one bundle per isolate across requests. */
const stsClients = new WeakMap<BundleBinding, Secrets>();

/**
 * The selected source, or `undefined` for an unrecognised value. Callers fail closed on
 * `undefined` and read neither source.
 */
export function secretsSource(
  env: Pick<SecuritySyncSecretsEnv, 'SECRETS_SOURCE'>
): SecuritySyncSecretsSource | undefined {
  const parsed = SecretsSourceSchema.safeParse(env.SECRETS_SOURCE ?? 'secrets-store');
  return parsed.success ? parsed.data : undefined;
}

/**
 * Reads `INTERNAL_API_SECRET` from the STS bundle and returns it as delivered, so each caller keeps
 * its own empty-value handling. It never throws and never reads the Secrets Store: a failure
 * returns only a fixed reason, so no error name, message or cause reaches a log or a response.
 */
export async function readStsInternalApiSecret(
  env: Pick<SecuritySyncSecretsEnv, 'STS'>
): Promise<StsReadResult> {
  const binding = env.STS;
  if (binding === undefined) return { ok: false, reason: 'binding_missing' };
  let client = stsClients.get(binding);
  if (client === undefined) {
    client = createWorkerSecrets(binding);
    stsClients.set(binding, client);
  }
  try {
    // The fetch and scheduled handlers take no execution context, so the module-level `waitUntil`
    // hands a revalidation this read starts to the invocation doing the read. It is loaded only on
    // this path: the Node unit tests cannot resolve the workerd built-in, and the `secrets-store`
    // source never needs it.
    const { waitUntil } = await import('cloudflare:workers');
    return { ok: true, value: await client.get(INTERNAL_API_SECRET, { waitUntil }) };
  } catch (error) {
    const reason =
      error instanceof SecretUnavailableError && Object.hasOwn(CLIENT_REASONS, error.reason)
        ? CLIENT_REASONS[error.reason]
        : 'read_failed';
    return { ok: false, reason };
  }
}
