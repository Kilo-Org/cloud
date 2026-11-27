import 'server-only';

/**
 * `USAGE_PUBLISHER_AUTH`, the publisher's credential switch and its rollback:
 * - absent or `legacy`: `USAGE_INGEST_PUBLISH_SECRET` to the configured `USAGE_INGEST_URL`, exactly
 *   as before this switch existed;
 * - `sts`: only an `STS_USAGE_PUBLISH` service token, only to this deployment's own Usage Ingest
 *   origin; never the secret, and no return to it when the token or the send fails.
 * Any other value publishes nothing.
 *
 * This module only validates the switch and the destination and imports nothing else, so a
 * `legacy` deployment never loads the STS token client, the Vercel OIDC exchange or the STS
 * contracts; `usage-publish-token.ts` holds them and is imported only for an STS publication.
 */
export type UsagePublisherAuth = 'legacy' | 'sts';

export function usagePublisherAuth(value: string | undefined): UsagePublisherAuth | null {
  if (value === undefined || value === 'legacy') return 'legacy';
  return value === 'sts' ? 'sts' : null;
}

export type PublishEnvironment = 'production' | 'staging';

/**
 * Each Usage Ingest script's `workers.dev` origin (the scripts have no routes), the same fixed
 * origins its publish routes name in their challenges. STS mode sends only here.
 */
export const USAGE_INGEST_STS_ORIGINS: Readonly<Record<PublishEnvironment, string>> = {
  production: 'https://usage-ingest.engineering-e11.workers.dev',
  staging: 'https://usage-ingest-staging.engineering-e11.workers.dev',
};

/** Vercel's system variables of the deployment; `process.env` in production. */
type VercelRuntime = { VERCEL_ENV?: string; VERCEL_TARGET_ENV?: string };

/**
 * Vercel production publishes to production and the `staging` custom environment to staging.
 * Previews and processes outside Vercel have no STS destination.
 */
function publishEnvironment(runtime: VercelRuntime): PublishEnvironment | null {
  const { VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === 'preview' && target === 'staging') return 'staging';
  return null;
}

export type StsPublishTarget = { origin: string; environment: PublishEnvironment };

/**
 * STS mode's origin and STS environment, both from the deployment's own environment.
 * `usageIngestUrl` must be exactly that environment's `/usage` URL, character for character: a URL
 * of the other environment, another host, a port, credentials, a query, a fragment or any other
 * spelling publishes nothing.
 */
export function stsPublishTarget(
  runtime: VercelRuntime,
  usageIngestUrl: string | undefined
): StsPublishTarget | null {
  const environment = publishEnvironment(runtime);
  if (environment === null) return null;
  const origin = USAGE_INGEST_STS_ORIGINS[environment];
  if (usageIngestUrl !== `${origin}/usage`) return null;
  return { origin, environment };
}
