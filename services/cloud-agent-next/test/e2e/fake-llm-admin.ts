/**
 * `/test/*` admin guard for the fake LLM, shared by both runtimes.
 *
 * Deliberately has no `@kilocode/worker-utils` import (LD1): the local Node
 * fake server and the E2E driver both import this module, and neither should
 * pull the Worker-only token-verification graph (jose, zod, drizzle) for it.
 * The model-token decision lives in `fake-llm-model-auth.ts` instead.
 *
 * `resolveFakeAdminToken` is the single place the Node side chooses the admin
 * token, so the fake server and the driver can never disagree about it.
 */

import { timingSafeEqual } from '@kilocode/encryption';

/**
 * Insecure development default. It exists only so a zero-config local stack can
 * authenticate its own `/test/*` calls; it is never protection. The public
 * tunnel refuses to publish it (`dev/local/scripts/start-public-tunnels.ts`)
 * and `test/e2e/deploy/deploy-fake-llm.sh` rejects it.
 */
export const LOCAL_FAKE_LLM_ADMIN_TOKEN = 'local-fake-llm-admin';

/** The environment shape the resolver reads. `process.env` fits. */
export type FakeAdminEnv = Record<string, string | undefined>;

/**
 * The one place the local-facing admin token is chosen: the operator's
 * `FAKE_LLM_ADMIN_TOKEN` when set, otherwise the insecure development default.
 */
export function resolveFakeAdminToken(env: FakeAdminEnv = process.env): string {
  return env.FAKE_LLM_ADMIN_TOKEN ?? LOCAL_FAKE_LLM_ADMIN_TOKEN;
}

function presentedBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const trimmed = authorization.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return trimmed.slice(7).trim() || null;
}

/**
 * Authorize one `/test/*` request. A missing/empty configured token fails
 * closed, so a Worker without `FAKE_LLM_ADMIN_TOKEN` rejects every `/test/*`
 * request while `/health` and the model routes stay unaffected.
 */
export function isAdminAuthorized(
  authorization: string | undefined,
  adminToken: string | undefined
): boolean {
  if (!adminToken) return false;
  const presented = presentedBearerToken(authorization);
  if (!presented) return false;
  return timingSafeEqual(presented, adminToken);
}
