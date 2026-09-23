import { TRPCError } from '@trpc/server';
import type { ProcedureType } from '@trpc/server';

import { RequestDeadlineError, withDeadline } from '@kilocode/event-service';
import { isMobileClient, type MinimumVersionHeaders } from '@/lib/trpc/min-version';
import { buildTimingLine, readClientDimensions } from '@/lib/observability/request-timing';

/**
 * Server-side budget for one mobile control-plane tRPC request.
 *
 * The app gives every control-plane call `CONTROL_PLANE_DEADLINE_MS = 15_000`
 * (`packages/event-service/src/deadline.ts`) and then abandons it. Without a
 * server-side bound the same request keeps running — and when the upstream
 * shared read (`getUserFromAuth` -> `findUserById(..., readDb)`) misses its
 * budget the gateway answers 504 instead of the app's own deadline. This budget
 * is strictly *below* that client deadline, leaving transport slack, so the
 * slow path fails with a settled tRPC error the app already renders as
 * retryable rather than hanging to the gateway.
 *
 * tRPC awaits `createContext` *before* any procedure middleware
 * (`@trpc/server` `resolveResponse`), and `user.getMe` itself awaits nothing.
 * The bound therefore wraps two surfaces that share one clock:
 * - `surface: 'context'` — `getUserFromAuth` inside `createTRPCContext`
 * - `surface: 'procedure'` (default) — the procedure pipeline, using whatever
 *   budget remains after context creation
 *
 * `CONTROL_PLANE_UPSTREAM_BUDGET_MS = 8_000` (`lib/bounded-service-fetch.ts`)
 * bounds a single internal-service fetch and so fires first; this budget is the
 * outer backstop for a request whose slow work is not one such fetch.
 *
 * This is a bound being added, never a widened timeout.
 */
export const CONTROL_PLANE_PROCEDURE_BUDGET_MS = 10_000;

const TRPC_HTTP_PREFIX = '/api/trpc/';

/**
 * The fields of tRPC's `TRPCRequestInfo` this module reads. Kept narrow so
 * `createTRPCContext` can accept the fetch adapter's `info` without depending
 * on `@trpc/server/http`.
 */
export type ControlPlaneRequestInfo = {
  type?: ProcedureType | 'unknown';
  calls?: ReadonlyArray<{ path: string }>;
  url?: URL | null;
};

export type ControlPlaneBudgetSurface = 'procedure' | 'context';

export type ControlPlaneBudgetOptions<TResult> = {
  /** tRPC procedure path, logged on expiry. Never carries a query string. */
  path: string;
  type: ProcedureType;
  headersList?: MinimumVersionHeaders | null;
  next: () => Promise<TResult>;
  /**
   * `performance.now()` when this request's budget started. Context creation
   * stamps it; the procedure middleware passes it through so both surfaces
   * share one 10s window. Omit to start a fresh clock (tests, callers).
   */
  startedAt?: number;
  /**
   * `procedure` (default): mobile queries only — mutations pass through.
   * `context`: every mobile caller — wraps `getUserFromAuth` so a hanging
   * shared read cannot become a gateway 504 on `user.getMe`.
   */
  surface?: ControlPlaneBudgetSurface;
};

/**
 * Procedure path for the budget-exceeded line. Prefers tRPC's parsed call
 * path; falls back to the URL pathname with the `/api/trpc/` prefix stripped.
 * Never reads `url.search`, so a query string cannot land in the log.
 */
export function controlPlanePathFromInfo(info?: ControlPlaneRequestInfo | null): string {
  const fromCall = info?.calls?.find(call => call.path.length > 0)?.path;
  if (fromCall !== undefined) {
    const queryAt = fromCall.indexOf('?');
    return queryAt === -1 ? fromCall : fromCall.slice(0, queryAt);
  }
  const pathname = info?.url?.pathname ?? '';
  const withoutPrefix = pathname.startsWith(TRPC_HTTP_PREFIX)
    ? pathname.slice(TRPC_HTTP_PREFIX.length)
    : pathname.replace(/^\/+/, '');
  const trimmed = withoutPrefix.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : 'trpc.context';
}

/**
 * Procedure type for the budget wrapper. An unknown tRPC request is treated as
 * a query so a hanging shared read is still bounded.
 */
export function controlPlaneTypeFromInfo(info?: ControlPlaneRequestInfo | null): ProcedureType {
  if (info?.type === 'mutation' || info?.type === 'subscription' || info?.type === 'query') {
    return info.type;
  }
  return 'query';
}

/**
 * Bound a mobile control-plane call to {@link CONTROL_PLANE_PROCEDURE_BUDGET_MS}.
 *
 * A non-mobile caller is returned untouched. On the procedure surface a
 * mutation/subscription is also returned untouched: the procedure budget
 * exists only to keep the app's query window. On the context surface every
 * mobile caller is bounded, because `getUserFromAuth` runs before tRPC knows
 * to dispatch `user.getMe`.
 *
 * When the deadline expires the rejection becomes a `INTERNAL_SERVER_ERROR`
 * TRPCError — the app's existing retryable outcome
 * (`apps/mobile/src/lib/query-client.ts`) — and one structured timing line
 * names the procedure path.
 *
 * The thrown message and cause carry no URL, query string, header, token, or
 * user id: the cause is the budget error alone, and the line omits `userId`.
 */
export async function withControlPlaneBudget<TResult>({
  path,
  type,
  headersList,
  next,
  startedAt,
  surface = 'procedure',
}: ControlPlaneBudgetOptions<TResult>): Promise<TResult> {
  if (!isMobileClient(headersList)) {
    return next();
  }
  if (surface === 'procedure' && type !== 'query') {
    return next();
  }

  const clockStart = startedAt ?? performance.now();
  const remainingMs = Math.min(
    CONTROL_PLANE_PROCEDURE_BUDGET_MS,
    CONTROL_PLANE_PROCEDURE_BUDGET_MS - (performance.now() - clockStart)
  );

  const timeout = (cause: RequestDeadlineError): never => {
    logControlPlaneBudgetExceeded({
      path,
      procedureType: type,
      headersList,
      durationMs: performance.now() - clockStart,
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Control-plane request timed out',
      cause,
    });
  };

  if (remainingMs <= 0) {
    timeout(new RequestDeadlineError(CONTROL_PLANE_PROCEDURE_BUDGET_MS));
  }

  const pending = next();
  // Once the deadline settles the race, nothing awaits `pending` any more.
  // Consume its eventual rejection here so an abandoned procedure can never
  // surface as an unhandled rejection on the server.
  void pending.catch(() => undefined);

  try {
    return await withDeadline(remainingMs, () => pending);
  } catch (error) {
    if (error instanceof RequestDeadlineError) {
      timeout(error);
    }
    // A procedure that settled with its own error keeps that error unchanged.
    throw error;
  }
}

/**
 * One allow-listed line, same shape as `buildTimingLine`, so the PR can quote
 * server-side timing without depending on `TRPC_TIMING_LOGGING`. It carries the
 * procedure path and the client dimensions, never a query string, request
 * header, token, or user id.
 */
function logControlPlaneBudgetExceeded({
  path,
  procedureType,
  headersList,
  durationMs,
}: {
  path: string;
  procedureType: ProcedureType;
  headersList?: MinimumVersionHeaders | null;
  durationMs: number;
}): void {
  try {
    console.log(
      JSON.stringify(
        buildTimingLine({
          surface: 'trpc',
          path,
          procedureType,
          durationMs: Math.round(durationMs),
          ok: false,
          // Omitted from the line: this surface names the procedure path only.
          userId: null,
          dimensions: readClientDimensions(headersList),
        })
      )
    );
  } catch {
    // Logging must never throw into the request path.
  }
}
