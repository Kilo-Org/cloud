import 'server-only';
import { headers } from 'next/headers';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { ProcedureType } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import type { OrganizationAccess } from '@kilocode/web-shared/lib/admin/support-access';
import {
  cloudAgentAuthorityProcedureKind,
  cloudAgentAuthorityProcedures,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  emitAdminAccessEvent,
  emitPrivilegedAccessEvent,
  userAgentProductFromHeaders,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  deriveCredentialKind,
  type AdminStepUpState,
  type PrivilegedCredentialKind,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  actionClassForAdminProcedure,
  markPrivilegedGuard,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { setTag, trpcMiddleware } from '@sentry/nextjs';
import { AuthContextError, trpcErrorFormatter } from '@kilocode/web-shared/lib/trpc/transport';
import {
  appUpdateRequiredError,
  enforceMinimumVersion,
  getMinimumVersions,
  isMobileClient,
} from '@kilocode/web-shared/lib/trpc/min-version';
import {
  buildTimingLine,
  readClientDimensions,
  shouldLogTiming,
} from '@kilocode/web-shared/lib/observability/request-timing';
import {
  controlPlanePathFromInfo,
  controlPlaneTypeFromInfo,
  withControlPlaneBudget,
  type ControlPlaneRequestInfo,
} from '@kilocode/web-shared/lib/trpc/control-plane-budget';

export { UpstreamApiError } from '@kilocode/web-shared/lib/trpc/transport';
// Define the context type
export type TRPCContext = {
  user: User;
  deviceSessionId?: string;
  cloudAgentAuthority?: CloudAgentAuthority;
  // Admin audit signals threaded from the auth layer so `adminProcedure` can
  // emit IP-independent, identity-attributed access telemetry. Optional so the
  // many existing `{ user }` context constructors (tests, scripts) keep working;
  // production `createTRPCContext` always populates them.
  authViaToken?: boolean;
  tokenSource?: string | null;
  /**
   * Provenance derived once at the request boundary. `adminProcedure` and the
   * privileged-access telemetry read this instead of re-deriving from
   * `authViaToken` so a scoped or delegated token cannot be mislabeled as a
   * human session.
   */
  credential?: PrivilegedCredentialKind;
  internalApiUse?: boolean;
  /**
   * Server-only identifiers for the browser session that authenticated this
   * request. Absent for bearer credentials and for legacy session cookies that
   * predate the `webSessionId` claim.
   */
  webSessionId?: string;
  webSessionPepper?: string | null;
  /**
   * Step-up state measured by `adminProcedure` so a specialized guard chained
   * on it can reuse the result instead of evaluating twice.
   */
  adminStepUpState?: AdminStepUpState;
  ip?: string | null;
  // Procedure path and type, injected into the context by `baseProcedure` so
  // that `is_admin` elevation sites *inside* a resolver (which only receive
  // `ctx`, not the middleware's `path`/`type`) can attribute their audit event
  // to the exact procedure. Optional for the same reason as the fields above.
  trpcPath?: string;
  trpcType?: string;
  /**
   * Set by the organization procedure middlewares after one mode-aware
   * resolution, so a resolver can tell `member`, `legacy_admin`, and
   * `support` apart without re-querying.
   */
  organizationAccess?: OrganizationAccess;
  // Populated by `createTRPCContext` and read by the min-version middleware.
  headersList?: Headers;
  // `performance.now()` when the mobile control-plane budget started, set by
  // `createTRPCContext` so the procedure middleware shares the same 10s window
  // as the shared auth read. Absent for web/CLI callers and test constructors.
  controlPlaneStartedAt?: number;
};

/**
 * Optional fetch-adapter argument. tRPC's `createContext` passes `{ req, info }`;
 * callers that invoke this with no args (SSR prefetch, REST wrappers) fall
 * back to `next/headers()` and a generic path.
 */
export type CreateTRPCContextOpts = {
  req?: Request;
  info?: ControlPlaneRequestInfo;
};

/**
 * @see: https://trpc.io/docs/server/context
 *
 * The shared auth read (`getUserFromAuth` -> `findUserById(..., readDb)`) is
 * the only upstream `user.getMe` awaits, and tRPC runs it *before* procedure
 * middleware. Wrapping it here is what keeps a hanging replica read from
 * becoming a gateway 504; the procedure middleware then consumes whatever
 * budget remains.
 */
export const createTRPCContext = async (opts?: CreateTRPCContextOpts): Promise<TRPCContext> => {
  const headersList = opts?.req?.headers ?? (await headers());
  const startedAt = performance.now();
  const {
    user,
    deviceSessionId,
    tokenSource,
    cloudAgentAuthority,
    internalApiUse,
    webSessionId,
    webSessionPepper,
  } = await withControlPlaneBudget({
    path: controlPlanePathFromInfo(opts?.info),
    type: controlPlaneTypeFromInfo(opts?.info),
    headersList,
    next: () =>
      getUserFromAuth({
        adminOnly: false,
        requestHeaders: headersList,
        requestPathname: opts?.req ? new URL(opts.req.url).pathname : undefined,
      }),
    startedAt,
    surface: 'context',
  });
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated - no user to set on context',
      // Marks this as a genuine session failure (vs a procedure-level
      // UNAUTHORIZED like org-access denial) so the mobile client signs out
      // only here — see AuthContextError / data.authRequired.
      cause: new AuthContextError(),
    });
  }
  setTag('userId', user.id);
  const authViaToken = authViaTokenFromHeaders(headersList);
  return {
    user,
    deviceSessionId,
    cloudAgentAuthority,
    authViaToken,
    credential: deriveCredentialKind({
      authViaToken,
      tokenSource: tokenSource ?? null,
      internalApiUse,
      delegatedWorkload: cloudAgentAuthority !== undefined,
    }),
    internalApiUse,
    tokenSource: tokenSource ?? null,
    webSessionId,
    webSessionPepper: webSessionPepper ?? null,
    ip: clientIpFromHeaders(headersList),
    headersList,
    controlPlaneStartedAt: isMobileClient(headersList) ? startedAt : undefined,
  };
};

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter: trpcErrorFormatter,
});

const sentryMiddleware = t.middleware(
  trpcMiddleware({
    attachRpcInput: false,
  })
);

/**
 * Options this middleware reads. Kept narrow so the timing behaviour can be
 * driven directly in `init-timing.test.ts`; `baseProcedure.use` accepts it as a
 * regular middleware function.
 */
export type TimingMiddlewareOptions<TResult extends { ok: boolean }> = {
  path: string;
  type: ProcedureType;
  ctx: TRPCContext;
  next: () => Promise<TResult>;
};

export const timingMiddleware = async <TResult extends { ok: boolean }>({
  path,
  type,
  ctx,
  next,
}: TimingMiddlewareOptions<TResult>): Promise<TResult> => {
  if (process.env.TRPC_TIMING_LOGGING !== '1') return next();

  const start = performance.now();
  const result = await next();
  const durationMs = performance.now() - start;
  const dimensions = readClientDimensions(ctx.headersList);
  if (!shouldLogTiming({ client: dimensions.client })) return result;
  console.log(
    JSON.stringify(
      buildTimingLine({
        surface: 'trpc',
        path,
        procedureType: type, // 'query' | 'mutation' | 'subscription'
        durationMs: Math.round(durationMs),
        ok: result.ok,
        userId: ctx.user?.id ?? null,
        dimensions,
      })
    )
  );
  return result;
};

// Bounds a mobile query's procedure pipeline to whatever remains of the
// control-plane budget started in `createTRPCContext`. Web/CLI callers and
// mutations pass through untouched; see `control-plane-budget.ts`.
const controlPlaneBudgetMiddleware = t.middleware(({ path, type, ctx, next }) =>
  withControlPlaneBudget({
    path,
    type,
    headersList: ctx.headersList,
    next,
    startedAt: ctx.controlPlaneStartedAt,
  })
);

// Publishes the procedure path/type onto the context so audit emitters reachable
// only from a resolver (see `recordKiloAdminElevation`) can name the procedure.
// `next({ ctx })` merges into the existing context, so nothing is dropped.
const auditContextMiddleware = t.middleware(({ path, type, next }) =>
  next({ ctx: { trpcPath: path, trpcType: type } })
);

// Refuses a mobile client whose app version is below the configured minimum.
// Web/CLI callers (and any caller without a `headersList`) short-circuit on
// `isMobileClient` and pass without a DB read.
// `getMinimumVersions` rejects with a retryable SERVICE_UNAVAILABLE when the
// read failed and nothing is cached, and that rejection passes through here
// unchanged, so only a version verdict becomes a FORBIDDEN app update here.
// Runs before `sentryMiddleware`: both outcomes are expected gate verdicts, and
// the read failure is already reported once per backoff window, so the tRPC
// Sentry middleware must not capture one event per request during an outage
// (its capture reaches `beforeSend`, which only drops tRPC 4xx errors).
const minimumVersionMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!isMobileClient(ctx.headersList)) return next();
  const minimums = await getMinimumVersions();
  if (!minimums || !enforceMinimumVersion(ctx.headersList, minimums).pass) {
    throw appUpdateRequiredError();
  }
  return next();
});

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
const cloudAgentAuthorityMiddleware = t.middleware(
  async ({ ctx, path, type, getRawInput, next }) => {
    if (ctx.cloudAgentAuthority === undefined) return next();
    try {
      if (ctx.cloudAgentAuthority.ownerId !== ctx.user.id) {
        throw new Error('Invalid scoped caller');
      }
      if (!cloudAgentAuthorityProcedures(ctx.cloudAgentAuthority).includes(path)) {
        throw new Error('Cloud Agent authority does not permit this procedure');
      }
      if (cloudAgentAuthorityProcedureKind(path) !== type) {
        throw new Error('Cloud Agent authority procedure kind mismatch');
      }
      validateCloudAgentAuthorityRequest(ctx.cloudAgentAuthority, path, await getRawInput());
    } catch {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent authority denied' });
    }
    return next();
  }
);
export const baseProcedure = t.procedure
  .use(cloudAgentAuthorityMiddleware)
  .use(timingMiddleware)
  .use(controlPlaneBudgetMiddleware)
  .use(minimumVersionMiddleware)
  .use(sentryMiddleware)
  .use(auditContextMiddleware);

// Admin-only procedure. The creditManager/superadmin/sessionViewer procedures in
// lib/trpc/admin-procedures chain on this, so emitting here covers the whole
// admin.* tRPC surface with a single event.
type AdminGuardFn = Parameters<typeof t.middleware>[0];
const adminGuardFn = markPrivilegedGuard<AdminGuardFn>(async ({ ctx, path, type, next }) => {
  const credential =
    ctx.credential ??
    deriveCredentialKind({
      authViaToken: ctx.authViaToken ?? false,
      tokenSource: ctx.tokenSource ?? null,
      internalApiUse: ctx.internalApiUse,
    });
  const isBearer = credential !== 'session';
  const { actionClass, inventoryId } = actionClassForAdminProcedure(path, type);
  const emitPrivileged = (outcome: 'succeeded' | 'denied' | 'failed') =>
    emitPrivilegedAccessEvent({
      surface: 'trpc',
      user: ctx.user,
      credential,
      outcome,
      actionClass,
      actionId: inventoryId,
      target: null,
      wouldBlock: true,
      userAgentProduct: userAgentProductFromHeaders(ctx.headersList ?? new Headers()),
      tokenSource: ctx.tokenSource ?? null,
      route: path,
      method: type,
      ip: ctx.ip ?? null,
    });

  if (!ctx.user.is_admin) {
    if (isBearer) emitPrivileged('denied');
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  emitAdminAccessEvent({
    surface: 'trpc',
    kind: 'admin_guard',
    user: ctx.user,
    authViaToken: ctx.authViaToken ?? false,
    tokenSource: ctx.tokenSource ?? null,
    credential,
    wouldBlock: isBearer,
    userAgentProduct: userAgentProductFromHeaders(ctx.headersList ?? new Headers()),
    route: path,
    method: type,
    ip: ctx.ip ?? null,
  });
  try {
    const result = await next();
    if (isBearer) {
      if (result.ok) {
        emitPrivileged('succeeded');
      } else if (result.error.code === 'FORBIDDEN' || result.error.code === 'UNAUTHORIZED') {
        emitPrivileged('denied');
      } else {
        emitPrivileged('failed');
      }
    }
    return result;
  } catch (error) {
    if (isBearer) emitPrivileged('failed');
    throw error;
  }
}, 'admin');

const adminGuardMiddleware = t.middleware(adminGuardFn);

// Enforcement for every admin procedure when the switch is on. When it is off
// this performs no reads. `stepUp.*` is exempt so the dialog can read status and
// the user can lock a session; both still require an admin browser session.
// Specialized guards chained on adminProcedure reuse `adminStepUpState`.
const adminStepUpEnforcementMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  const enabled = isAdminStepUpEnabled();
  if (!enabled || path.startsWith('stepUp.')) return next();

  const credential =
    ctx.credential ??
    deriveCredentialKind({
      authViaToken: ctx.authViaToken ?? false,
      tokenSource: ctx.tokenSource ?? null,
      internalApiUse: ctx.internalApiUse,
    });
  const { actionClass } = actionClassForAdminProcedure(path, type);

  const adminStepUpState = await runStepUpGuard({
    userId: ctx.user.id,
    credential,
    webSessionId: ctx.webSessionId,
    actionClass,
    enabled,
    route: path,
    method: type,
    surface: 'trpc',
  });

  return next({ ctx: { adminStepUpState } });
});

export const adminProcedure = baseProcedure
  .use(adminGuardMiddleware)
  .use(adminStepUpEnforcementMiddleware);
