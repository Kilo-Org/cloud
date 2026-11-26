import 'server-only';
import { headers } from 'next/headers';
import { accountBlockedRefusalReason, isSelfCleanupProcedureCall } from '@kilocode/app-shared/auth';
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
  type AdminStepUpDecision,
  type AdminStepUpState,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type PrivilegedTarget,
  type PrivilegedTargetKind,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  actionClassForAdminProcedure,
  markPrivilegedGuard,
  resolvesOwnStepUp,
  targetIdFieldForAdminProcedure,
  targetIdFromInput,
  targetKindForInputField,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';
import {
  isAdminAuditInputRejection,
  reportAdminAuditGap,
  runAdminAuditScope,
  type AdminAuditSpec,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isOperationStepUpClass } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { captureMessage, setTag, trpcMiddleware } from '@sentry/nextjs';
import {
  AccountBlockedError,
  AuthContextError,
  trpcErrorFormatter,
} from '@kilocode/web-shared/lib/trpc/transport';
import {
  appUpdateRequiredError,
  enforceMinimumVersion,
  getMinimumVersions,
  NO_ROW_CACHE_TTL_MS,
} from '@kilocode/web-shared/lib/trpc/min-version';
import { APP_CLIENT_HEADER, isMobileClient } from '@kilocode/web-shared/lib/app-headers';
import {
  buildTimingLine,
  readClientDimensions,
  shouldLogTiming,
} from '@kilocode/web-shared/lib/observability/request-timing';
import type { ModelStatsLoadClient } from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import {
  controlPlanePathFromInfo,
  controlPlaneTypeFromInfo,
  withControlPlaneBudget,
  type ControlPlaneRequestInfo,
} from '@kilocode/web-shared/lib/trpc/control-plane-budget';

export { UpstreamApiError } from '@kilocode/web-shared/lib/trpc/transport';

// The admission is keyed on the whole request, never on the first call: a
// batch that mixes a cleanup with any other call is refused as before, so the
// exemption cannot carry another procedure through the gate. Which procedures
// count as a cleanup, and why, is the shared list the mobile client also reads
// (`@kilocode/app-shared/auth`): it keeps those calls out of its batch, so the
// two sides cannot drift.
//
// The exemption covers self-scoped writes only. The request must itself be a
// mutation, and each call must be a listed cleanup declared as one, so a query
// never enters the exemption even if its path were added to the shared list: a
// refused account cannot gain a read this way.
function admitsRefusedAccount(info: ControlPlaneRequestInfo | null | undefined): boolean {
  const type = info?.type;
  const calls = info?.calls;
  if (type !== 'mutation') return false;
  if (!calls || calls.length === 0) return false;
  return calls.every(call => isSelfCleanupProcedureCall({ path: call.path, type }));
}

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
  /**
   * What the admin step-up middleware authorized for this request: the action
   * class and target its guard measured. A specialized guard chained on it
   * reads this to refuse reusing a decision that does not cover its own
   * request.
   */
  adminStepUpDecision?: AdminStepUpDecision;
  /**
   * Credential and privileged-inventory entry resolved once by the admin guard,
   * so the step-up enforcement chained after it and specialized guards cannot
   * name a different credential or action for the same request.
   */
  adminAttribution?: AdminAttribution;
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
  /** Per-request step-up state. Each request gets its own set. */
  stepUpClaims?: Set<string>;
  // Populated by `createTRPCContext` and read by the min-version middleware.
  headersList?: Headers;
  // `performance.now()` when the mobile control-plane budget started, set by
  // `createTRPCContext` so the procedure middleware shares the same 10s window
  // as the shared auth read. Absent for web/CLI callers and test constructors.
  controlPlaneStartedAt?: number;
  /**
   * Read client for model-stats snapshot loads and the organization member gate's
   * membership read. The gateway's REST facet sets `readDb` because its handlers
   * run in `sfo1`; the web app leaves it unset and loads through the primary,
   * which it must after a write invalidation.
   */
  fromDb?: ModelStatsLoadClient;
};

/**
 * Optional fetch-adapter argument. tRPC's `createContext` passes `{ req, info }`;
 * callers that invoke this with no args (SSR prefetch, REST wrappers) fall
 * back to `next/headers()` and a generic path.
 */
export type CreateTRPCContextOpts = {
  req?: Request;
  info?: ControlPlaneRequestInfo;
  /** Sets `TRPCContext.fromDb`; the gateway's REST facet passes `readDb`. */
  fromDb?: ModelStatsLoadClient;
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
    refusalReason,
  } = await withControlPlaneBudget({
    path: controlPlanePathFromInfo(opts?.info),
    type: controlPlaneTypeFromInfo(opts?.info),
    headersList,
    next: () =>
      getUserFromAuth({
        adminOnly: false,
        requestHeaders: headersList,
        requestPathname: opts?.req ? new URL(opts.req.url).pathname : undefined,
        // A refused account still owns the session it is signing out of. The
        // admission covers only the cleanup procedures (see
        // admitsRefusedAccount), so every other call keeps the block refusal
        // below.
        allowRefusedAccountSelfCleanup: admitsRefusedAccount(opts?.info),
      }),
    startedAt,
    surface: 'context',
  });
  // Authorization refused the account itself (R0 domain blacklist / R1 blocked
  // account) while the session is intact. That is a different answer from a
  // missing session: the mobile app must show why the account cannot be used
  // and keep the user signed in, so this refuses with its own cause instead of
  // reaching the AuthContextError branch below.
  //
  // Both refusals keep the same HTTP/tRPC shape (FORBIDDEN, `data.accountBlocked`)
  // and differ only in the reason published beside it. The reason is what lets
  // the app drop a retry: R1 (`account_blocked`) is one account's property,
  // which support can lift, while R0 (`email_domain_blocked`) is the email
  // domain's, so no retry, sign-out or sign-in can satisfy it.
  //
  // Only the first-party mobile client gets that answer. The web app already
  // routes a blocked account to /account-blocked from its UNAUTHORIZED path
  // (sign-in -> after-sign-in -> /account-blocked), and no web consumer reads
  // `data.accountBlocked`, so every other client falls through to the
  // merge-base UNAUTHORIZED answer unchanged.
  const accountBlockedReason = accountBlockedRefusalReason(refusalReason);
  if (accountBlockedReason !== null && isMobileClient(headersList?.get(APP_CLIENT_HEADER))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Account access is blocked',
      cause: new AccountBlockedError(accountBlockedReason),
    });
  }
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
    credential: deriveContextCredential({
      authViaToken,
      tokenSource,
      internalApiUse,
      cloudAgentAuthority,
    }),
    internalApiUse,
    tokenSource: tokenSource ?? null,
    webSessionId,
    webSessionPepper: webSessionPepper ?? null,
    ip: clientIpFromHeaders(headersList),
    headersList,
    stepUpClaims: new Set<string>(),
    controlPlaneStartedAt: isMobileClient(headersList?.get(APP_CLIENT_HEADER))
      ? startedAt
      : undefined,
    fromDb: opts?.fromDb,
  };
};

/**
 * Procedure meta. `adminAudit` declares how an admin mutation is audited; the
 * admin audit middleware on `adminProcedure` enforces it.
 */
export type TRPCMeta = {
  adminAudit?: AdminAuditSpec;
};

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC.context<TRPCContext>().meta<TRPCMeta>().create({
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
// unchanged. When the read succeeded but found no configuration row, it
// resolves `null`: that is a missing configuration, not a version verdict, so
// the call proceeds and the missing configuration is reported once per no-row
// cache window. Only a version verdict becomes a FORBIDDEN app update here.
// Runs before `sentryMiddleware`: all outcomes are expected gate verdicts, and
// the read failure and the no-row report are throttled by their own windows, so
// the tRPC Sentry middleware must not capture one event per request during an
// outage (its capture reaches `beforeSend`, which only drops tRPC 4xx errors).
let lastNoRowReportAt = 0;
const minimumVersionMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!isMobileClient(ctx.headersList?.get(APP_CLIENT_HEADER))) return next();
  const minimums = await getMinimumVersions();
  if (minimums === null) {
    // The gate's configuration is absent. Serve — an update cannot fix a
    // missing row — but report so the missing configuration is visible.
    const now = Date.now();
    if (now - lastNoRowReportAt >= NO_ROW_CACHE_TTL_MS) {
      lastNoRowReportAt = now;
      captureMessage(
        'SUSPICIOUS: no app_min_versions row configured; serving mobile callers unguarded',
        {
          level: 'error',
          tags: { source: 'min_version_gate' },
        }
      );
    }
    return next();
  }
  if (!enforceMinimumVersion(ctx.headersList, minimums).pass) {
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

export type AdminAttribution = {
  credential: PrivilegedCredentialKind;
  actionClass: PrivilegedActionClass;
  inventoryId: string | null;
  targetKind: PrivilegedTargetKind;
};

/**
 * The one credential-provenance derivation for a tRPC context, from the same
 * four inputs at the request boundary and at the admin guard's fallback so a
 * delegated caller is classified identically wherever the context was built
 * or re-read.
 */
function deriveContextCredential(ctx: {
  authViaToken?: boolean;
  tokenSource?: string | null;
  internalApiUse?: boolean;
  cloudAgentAuthority?: CloudAgentAuthority;
}): PrivilegedCredentialKind {
  return deriveCredentialKind({
    authViaToken: ctx.authViaToken ?? false,
    tokenSource: ctx.tokenSource ?? null,
    internalApiUse: ctx.internalApiUse,
    delegatedWorkload: ctx.cloudAgentAuthority !== undefined,
  });
}

function resolveAdminAttribution(ctx: TRPCContext, path: string, type: string): AdminAttribution {
  if (ctx.adminAttribution) return ctx.adminAttribution;
  const credential = ctx.credential ?? deriveContextCredential(ctx);
  return { credential, ...actionClassForAdminProcedure(path, type) };
}

// Admin-only procedure. The creditManager/superadmin/sessionViewer procedures in
// lib/trpc/admin-procedures chain on this, so emitting here covers the whole
// admin.* tRPC surface with a single event.
type AdminGuardFn = Parameters<typeof t.middleware>[0];
const adminGuardFn = markPrivilegedGuard<AdminGuardFn>(async ({ ctx, path, type, next }) => {
  const attribution = resolveAdminAttribution(ctx, path, type);
  const isBearer = attribution.credential !== 'session';
  const emitPrivileged = (outcome: 'succeeded' | 'denied' | 'failed') =>
    emitPrivilegedAccessEvent({
      surface: 'trpc',
      user: ctx.user,
      credential: attribution.credential,
      outcome,
      actionClass: attribution.actionClass,
      actionId: attribution.inventoryId,
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
    credential: attribution.credential,
    wouldBlock: isBearer,
    userAgentProduct: userAgentProductFromHeaders(ctx.headersList ?? new Headers()),
    route: path,
    method: type,
    ip: ctx.ip ?? null,
  });
  try {
    const result = await next({ ctx: { adminAttribution: attribution } });
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
// A procedure listed in `ADMIN_STEP_UP_SELF_GUARDED_ROUTES` is exempt because
// its resolver binds the proof to the organization it acts on; the inventory
// test keeps that list and those resolvers in step.
// Specialized guards chained on adminProcedure reuse `adminStepUpState` and
// check `adminStepUpDecision` before trusting it for their own request.
const adminStepUpEnforcementMiddleware = t.middleware(
  async ({ ctx, path, type, getRawInput, next }) => {
    const enabled = isAdminStepUpEnabled();
    if (!enabled || path.startsWith('stepUp.') || resolvesOwnStepUp(path)) return next();

    // The attribution lookup already resolved the inventory entry, which names
    // the target kind; re-deriving it would be a second lookup for the same
    // value.
    const { credential, actionClass, targetKind } = resolveAdminAttribution(ctx, path, type);
    // An operation proof is bound to the account or organization the request
    // input names. A session-class decision ignores the target, so it stays
    // unbound.
    let target: PrivilegedTarget = { kind: targetKind, id: null };
    if (isOperationStepUpClass(actionClass)) {
      const field = targetIdFieldForAdminProcedure(path);
      if (field !== null) {
        const id = targetIdFromInput(field, await getRawInput());
        if (id !== null) target = { kind: targetKindForInputField(field), id };
      }
    }

    const adminStepUpState = await runStepUpGuard({
      userId: ctx.user.id,
      credential,
      webSessionId: ctx.webSessionId,
      actionClass,
      target,
      enabled,
      route: path,
      method: type,
      surface: 'trpc',
    });

    return next({ ctx: { adminStepUpState, adminStepUpDecision: { actionClass, target } } });
  }
);

// Audits every admin mutation, including those of the specialized procedures
// chained on `adminProcedure`, from its `adminAudit` meta. It runs after the
// admin guard, so a refused non-admin records nothing, and before the step-up
// guard and any specialized guard chained later, so their refusals are
// recorded as failures. Input that never parsed records its failure with no
// target.
const adminAuditMiddleware = t.middleware(({ ctx, meta, path, type, getRawInput, next }) => {
  if (type !== 'mutation') return next();
  const spec = meta?.adminAudit;
  if (spec === undefined) {
    reportAdminAuditGap(`${path} declares no adminAudit meta`);
    return next();
  }
  return runAdminAuditScope({
    spec,
    route: path,
    context: () => ctx,
    input: getRawInput,
    run: () => next(),
    outcomeOf: result =>
      result.ok
        ? { outcome: 'success' }
        : {
            outcome: 'failure',
            errorCode: result.error.code,
            inputRejected: isAdminAuditInputRejection(result.error),
          },
  });
});

export const adminProcedure = baseProcedure
  .use(adminGuardMiddleware)
  .use(adminAuditMiddleware)
  .use(adminStepUpEnforcementMiddleware);
