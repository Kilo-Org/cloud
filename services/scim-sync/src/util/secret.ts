import { getCachedSecret } from '@kilocode/worker-utils';

/**
 * Resolves one of this Worker's secrets.
 *
 * Deployed configs bind the Cloudflare Secrets Store, which is cached for the
 * isolate's lifetime by `getCachedSecret` — these values are read on every
 * poll, so re-fetching them each time would add three round trips per alarm.
 *
 * A plain string is accepted because `wrangler.test.jsonc` declares these as
 * plain `vars`, which keeps the test suite from depending on local Secrets
 * Store state. `wrangler dev` is different: `.dev.vars` overrides `vars` but
 * does *not* shadow a Secrets Store binding, so a local run needs the secrets
 * seeded into the store itself — see README.md "Secrets". The same union is how
 * `gastown` and `webhook-agent-ingest` handle it.
 */
export function resolveSecret(binding: SecretsStoreSecret | string, name: string): Promise<string> {
  return typeof binding === 'string' ? Promise.resolve(binding) : getCachedSecret(binding, name);
}
