import { getCachedSecret } from '@kilocode/worker-utils';

/**
 * Resolves one of this Worker's secrets.
 *
 * Deployed configs bind the Cloudflare Secrets Store, which is cached for the
 * isolate's lifetime by `getCachedSecret` — these values are read on every
 * poll, so re-fetching them each time would add three round trips per alarm.
 *
 * A plain string is accepted because a binding is not available in every
 * config a Worker runs under: the Secrets Store has no local seeding path, so
 * `wrangler.test.jsonc` and a `.dev.vars` supply the value as a var instead.
 * The same union is how `gastown` and `webhook-agent-ingest` handle it.
 */
export function resolveSecret(binding: SecretsStoreSecret | string, name: string): Promise<string> {
  return typeof binding === 'string' ? Promise.resolve(binding) : getCachedSecret(binding, name);
}
