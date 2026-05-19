/**
 * Fetches a fresh DoltHub OAuth access token from the web app's
 * `/api/internal/integrations/dolthub/token` endpoint.
 *
 * Why we don't read from the wasteland's local credential store:
 * `wasteland_credentials.encrypted_token` is a one-shot snapshot taken
 * when the user first connected DoltHub. OAuth access tokens rotate
 * (DoltHub refreshes them via `refresh_token`), and only the web app —
 * which owns the `platform_integrations` row — can perform the
 * refresh. Wasteland calling the web app on every op keeps tokens
 * fresh and removes the need for refresh-token logic on the worker.
 *
 * When OAuth is unavailable, callers can fall back to whatever credential
 * is stored locally. The fallback path is the responsibility of the caller —
 * see `loadSdkContext` in `wanted-board/wanted-board-ops-sdk.ts` and
 * `loadContext` in `branch-ops/branch-ops.ts` /
 * `lifecycle-ops/lifecycle-ops.ts`.
 */

import { resolveSecret } from './secret.util';
import { z } from 'zod';

const FreshTokenResponseSchema = z.object({
  token: z.string().min(1),
  dolthubUsername: z.string().nullable().optional(),
});

export type FreshDoltHubToken = {
  token: string;
  dolthubUsername: string | null;
};

export type FetchFreshTokenResult =
  | { status: 'ok'; data: FreshDoltHubToken }
  | { status: 'not-installed' }
  | { status: 'not-active' }
  | { status: 'unavailable'; reason: string };

/**
 * Calls the web app's internal token endpoint. Returns a discriminated
 * union the caller can switch on:
 *
 * - `'ok'` — fresh token returned. Use it.
 * - `'not-installed'` — user has no DoltHub OAuth integration. Caller
 *   should fall back to the locally stored credential.
 * - `'not-active'` — integration exists but is disconnected. Same
 *   fallback.
 * - `'unavailable'` — secret missing, web app down, etc. Caller should
 *   fall back to the locally stored credential and surface the reason in
 *   logs.
 */
export async function fetchFreshDoltHubToken(
  env: Env,
  params: { userId: string; organizationId?: string }
): Promise<FetchFreshTokenResult> {
  const secret = await resolveSecret(env.INTERNAL_API_SECRET);
  if (!secret) {
    return { status: 'unavailable', reason: 'INTERNAL_API_SECRET unavailable' };
  }

  const url = `${env.KILO_INTERNAL_API_URL}/api/internal/integrations/dolthub/token`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({
        userId: params.userId,
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      }),
    });
  } catch (err) {
    return {
      status: 'unavailable',
      reason: `transport error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 404) {
    // 404 means either the integration isn't installed (per-user) or
    // the route itself is disabled (production OAuth gating). The web
    // app distinguishes the two via response body, but for our caller
    // both lead to the same fallback path.
    const body = await response.text().catch(() => '');
    if (body.includes('integration not installed')) {
      return { status: 'not-installed' };
    }
    return { status: 'unavailable', reason: 'route returned 404' };
  }

  if (response.status === 409) {
    return { status: 'not-active' };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      status: 'unavailable',
      reason: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  const json: unknown = await response.json().catch(() => null);
  const parsed = FreshTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'unavailable',
      reason: 'unexpected response shape from token endpoint',
    };
  }

  return {
    status: 'ok',
    data: {
      token: parsed.data.token,
      dolthubUsername: parsed.data.dolthubUsername ?? null,
    },
  };
}
