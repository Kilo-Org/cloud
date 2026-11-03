import { z } from 'zod';
import { logger } from './log.util';

const POSTHOG_FLAGS_URL = 'https://us.i.posthog.com/flags/?v=2';
const POSTHOG_TIMEOUT_MS = 5_000;
export const GASTOWN_ACCESS_FLAG = 'gastown-access';

/** `unknown` means PostHog gave no reliable answer; keep the previous verdict. */
export type GastownAccessVerdict = 'allowed' | 'denied' | 'unknown';

const FlagsResponse = z.object({
  flags: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
  errorsWhileComputingFlags: z.boolean().optional(),
  quotaLimited: z.array(z.string()).optional(),
});

export function parseGastownAccessVerdict(body: unknown): GastownAccessVerdict {
  const parsed = FlagsResponse.safeParse(body);
  if (!parsed.success) return 'unknown';
  const { flags, errorsWhileComputingFlags, quotaLimited } = parsed.data;
  if (errorsWhileComputingFlags || quotaLimited?.includes('feature_flags')) return 'unknown';
  // A flag missing from a complete response is off, as the web token route sees it.
  return flags?.[GASTOWN_ACCESS_FLAG]?.enabled === true ? 'allowed' : 'denied';
}

/**
 * Evaluates the `gastown-access` PostHog flag for a user, the same flag the
 * web app checks before it mints Gastown tokens. Outside production the flag
 * is always on, matching `isGastownEnabled` in the web app.
 */
export async function evaluateGastownAccessFlag(
  env: Env,
  userId: string
): Promise<GastownAccessVerdict> {
  if (env.ENVIRONMENT !== 'production') return 'allowed';

  try {
    const response = await fetch(POSTHOG_FLAGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      // Same body as posthog-node `getFeatureFlag`, which the web token route uses.
      body: JSON.stringify({
        token: env.NEXT_PUBLIC_POSTHOG_KEY,
        distinct_id: userId,
        groups: {},
        person_properties: {},
        group_properties: {},
        geoip_disable: true,
        flag_keys_to_evaluate: [GASTOWN_ACCESS_FLAG],
      }),
    });
    if (!response.ok) {
      await response.text().catch(() => {});
      logger.warn('gastown access flag: PostHog request failed', { status: response.status });
      return 'unknown';
    }
    return parseGastownAccessVerdict(await response.json());
  } catch (error) {
    logger.warn('gastown access flag: PostHog request errored', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}
