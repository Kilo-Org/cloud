import 'server-only';

import { cli_sessions_v2 } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { TRPCContext } from '@/lib/trpc/init';

/**
 * Production polling interval for the server-side readiness wait. Matches the
 * contract surfaced to mobile: 250ms between attempts. The bound is
 * {@link READINESS_MAX_ATTEMPTS} attempts (40 → 10s total).
 */
export const READINESS_INTERVAL_MS = 250;

/**
 * Production attempt bound. Together with {@link READINESS_INTERVAL_MS} this
 * gives a 10-second total wait, which is short enough to keep the create-and-run
 * mutation responsive and long enough to absorb the normal CLI announce
 * round-trip plus the row write.
 */
export const READINESS_MAX_ATTEMPTS = 40;

export type ReadinessRow = {
  organizationId: string | null;
};

export type ReadinessDeps = {
  /**
   * Scoped DB probe. MUST filter by BOTH `session_id` and `kilo_user_id` so a
   * missing row and a row owned by another user both collapse to `null`. The
   * module never branches on the failure mode, so the caller can treat
   * "not found" and "other user" identically (always pending).
   */
  query: (sessionId: string, kiloUserId: string) => Promise<ReadinessRow | null>;
  /**
   * Validate the caller's current membership in the row's organization. The
   * router wires this to `ensureOrganizationAccess(ctx, organizationId)`.
   * Throws when the caller is no longer a member.
   */
  ensureOrganizationAccess: (organizationId: string) => Promise<void>;
  /**
   * Sleep helper. Optional; defaults to a 250ms-constant `setTimeout` Promise
   * so production callers can omit it. Tests inject a no-op `sleep` so they
   * never perform real waits.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Optional override for the per-attempt interval. Defaults to 250. */
  intervalMs?: number;
  /** Optional override for the attempt bound. Defaults to 40. */
  maxAttempts?: number;
};

/**
 * Production wiring. The router builds this once per call so the membership
 * helper sees the same `ctx` as the surrounding procedure.
 */
export function defaultReadinessDeps(ctx: TRPCContext): ReadinessDeps {
  return {
    query: async (sessionId, kiloUserId) => {
      const [row] = await db
        .select({ organizationId: cli_sessions_v2.organization_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        )
        .limit(1);
      if (!row) return null;
      return { organizationId: row.organizationId ?? null };
    },
    ensureOrganizationAccess: async organizationId => {
      await ensureOrganizationAccess(ctx, organizationId);
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

/**
 * Deterministic, side-effect-free readiness probe.
 *
 * Polls the owned `cli_sessions_v2` row at the configured interval and returns
 * `{ organizationId }` when the row appears. When the row's organizationId is
 * non-null, the caller's current membership is re-validated via the injected
 * `ensureOrganizationAccess` — a removed member is the caller's responsibility
 * to surface, the module does NOT swallow the rejection.
 *
 * Returns `null` when the row is not observed within the bound, so the caller
 * can return a `session_not_ready` recovery envelope without leaking whether
 * the session exists at all.
 *
 * A non-null row that fails the membership check throws — that is the
 * documented FORBIDDEN surface for `cliSessionsV2.readiness`. The
 * `localRuntimeControl.createAndRun` mutation surfaces a session_not_ready
 * recovery path because the same rejection is its own error class.
 */
export async function waitForOwnedCliSession(params: {
  sessionId: string;
  userId: string;
  deps: ReadinessDeps;
}): Promise<ReadinessRow | null> {
  const intervalMs = params.deps.intervalMs ?? READINESS_INTERVAL_MS;
  const maxAttempts = params.deps.maxAttempts ?? READINESS_MAX_ATTEMPTS;
  const sleep = params.deps.sleep ?? defaultSleep;
  if (maxAttempts < 1) {
    return null;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const row = await params.deps.query(params.sessionId, params.userId);
    if (row !== null) {
      if (row.organizationId !== null) {
        await params.deps.ensureOrganizationAccess(row.organizationId);
      }
      return row;
    }
    if (attempt < maxAttempts - 1) {
      await sleep(intervalMs);
    }
  }
  return null;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
