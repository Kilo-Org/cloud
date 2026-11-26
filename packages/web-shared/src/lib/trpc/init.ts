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
  admitStaff,
  differentOperationError,
  staffRefusalTrpcError,
  type StaffAdmission,
  type StaffAuthorization,
  type StaffProof,
} from '@kilocode/web-shared/lib/admin/admin-guard';
import { isOperationStepUpClass } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { stepUpDecisionCovers } from '@kilocode/web-shared/lib/admin/step-up-guard';
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
   * Step-up state measured by `adminProcedure` for a request proof, so a
   * specialized guard chained on it can reuse the result instead of
   * evaluating twice.
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
   * so specialized guards chained after it cannot name a different credential
   * or action for the same request.
   */
  adminAttribution?: AdminAttribution;
  /**
   * The staff admission `adminProcedure` made for this call. Its `user` is the
   * primary row, which also replaces `user` for the rest of the procedure.
   */
  adminAdmission?: StaffAdmission;
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
  /**
   * Step-up claims of one procedure call. `auditContextMiddleware` creates it
   * only for an admin caller, so batch calls never share it and ordinary calls
   * allocate nothing.
   */
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
    controlPlaneStartedAt: isMobileClient(headersList?.get(APP_CLIENT_HEADER))
      ? startedAt
      : undefined,
    fromDb: opts?.fromDb,
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
// An admin caller also gets the step-up claim set of this one procedure call:
// two calls in one HTTP batch never share a single-use proof, and an ordinary
// caller allocates nothing.
const auditContextMiddleware = t.middleware(({ ctx, path, type, next }) =>
  next({
    ctx: ctx.user.is_admin
      ? { trpcPath: path, trpcType: type, stepUpClaims: new Set<string>() }
      : { trpcPath: path, trpcType: type },
  })
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

/** The context fields a staff admission reads. */
export type StaffAuthorityContext = Pick<
  TRPCContext,
  | 'user'
  | 'credential'
  | 'webSessionId'
  | 'webSessionPepper'
  | 'headersList'
  | 'trpcPath'
  | 'trpcType'
  | 'stepUpClaims'
  | 'adminAdmission'
>;

// Staff state of one procedure call, keyed by that call's claim set: the
// admissions already made, so a middleware and its resolver that ask for the
// same thing share one admission and never spend a second proof, and the
// primary row the first admission read, so a later one does not read it again.
type StaffCallState = { admissions: Map<string, Promise<StaffAdmission>>; primaryUser?: User };
const staffStateByCall = new WeakMap<Set<string>, StaffCallState>();

/**
 * Staff authority for a procedure outside `adminProcedure`, such as an
 * organization helper that lets staff act without a membership. Call it only
 * on the staff branch, never for an ordinary caller.
 *
 * It admits a request proof for exactly `actionClass` and `target`. An
 * optional `authorize` callback runs inside the admission, after the current
 * role, network and browser-session checks and before the proof: it receives
 * the primary row and throws to refuse, so a path that must first validate an
 * organization or a support grant never spends or asks for a proof when that
 * validation fails. It runs on every call, also when the admission is reused.
 *
 * It throws the `adminProcedure` refusals and writes no audit event: the
 * caller records its own elevation after this returns. Use the returned
 * `user`, the primary row, for every later decision.
 *
 * Inside `adminProcedure` it reuses that admission only when its measured
 * decision covers exactly this action class, target and operation; any other
 * measured decision refuses the request instead of asking for a second proof.
 */
export async function requireStaffAuthority(
  ctx: StaffAuthorityContext,
  params: {
    actionClass: PrivilegedActionClass;
    target: PrivilegedTarget;
    authorize?: StaffAuthorization;
    /** Defaults to the procedure path; a REST handler passes its pathname. */
    route?: string;
    /** Defaults to the procedure type; a REST handler passes its HTTP method. */
    method?: string;
    surface?: 'trpc' | 'rest';
  }
): Promise<StaffAdmission> {
  const surface = params.surface ?? 'trpc';
  const route = params.route ?? ctx.trpcPath ?? null;
  const method = params.method ?? ctx.trpcType ?? null;
  const reuse = async (admission: StaffAdmission) => {
    await params.authorize?.(admission.user);
    return admission;
  };

  const upstream = ctx.adminAdmission;
  if (upstream?.decision) {
    const sameOperation = surface === 'trpc' && route === ctx.trpcPath && method === ctx.trpcType;
    if (
      sameOperation &&
      stepUpDecisionCovers(upstream.decision, params.actionClass, params.target)
    ) {
      return reuse(upstream);
    }
    // A request is evaluated once. A measured decision that does not cover
    // this action, target and operation refuses it instead of asking for a
    // second proof; with the switch off nothing was measured.
    if (upstream.stepUp.status !== 'absent') throw differentOperationError();
  }

  const call = ctx.stepUpClaims;
  let state = call ? staffStateByCall.get(call) : undefined;
  if (call && !state) {
    state = { admissions: new Map() };
    staffStateByCall.set(call, state);
  }

  const admit = async () => {
    const result = await admitStaff({
      user: ctx.user,
      primaryUser: upstream?.user ?? state?.primaryUser,
      credential: ctx.credential,
      webSessionId: ctx.webSessionId,
      webSessionPepper: ctx.webSessionPepper,
      headers: ctx.headersList ?? new Headers(),
      surface,
      route,
      method,
      actionClass: params.actionClass,
      proof: { kind: 'request', target: params.target, authorize: params.authorize },
    });
    if (!result.ok) throw staffRefusalTrpcError(result.refusal);
    if (state) state.primaryUser = result.admission.user;
    return result.admission;
  };

  if (!state) return admit();
  const key = [
    surface,
    route,
    method,
    params.actionClass,
    params.target.kind,
    params.target.id,
  ].join('|');
  const existing = state.admissions.get(key);
  if (existing) return reuse(await existing);
  const admission = admit();
  state.admissions.set(key, admission);
  // Only an admitted result is reused; a refusal or a failed check is not
  // remembered, so a later call runs the whole admission again.
  const admissions = state.admissions;
  void admission.catch(() => {
    if (admissions.get(key) === admission) admissions.delete(key);
  });
  return admission;
}

/** The only admin procedure that answers without a proof: the dialog's status read. */
const STEP_UP_STATUS_PROCEDURE = 'stepUp.getStatus';

function adminProcedureProof(params: {
  path: string;
  actionClass: PrivilegedActionClass;
  targetKind: PrivilegedTargetKind;
  getRawInput: () => Promise<unknown>;
}): StaffProof {
  if (params.path === STEP_UP_STATUS_PROCEDURE) return { kind: 'bootstrap' };
  // Each listed resolver binds the proof to the organization it resolves; the
  // inventory test keeps that list and those resolvers in step.
  if (resolvesOwnStepUp(params.path)) return { kind: 'resolver' };

  // An operation proof is bound to the account or organization the request
  // input names. A session-class decision ignores the target, so it stays
  // unbound. The admission resolves the target only after the role, network
  // and session checks, so the input is never read for a refused caller.
  return {
    kind: 'request',
    target: async () => {
      const unbound: PrivilegedTarget = { kind: params.targetKind, id: null };
      if (!isAdminStepUpEnabled() || !isOperationStepUpClass(params.actionClass)) return unbound;
      const field = targetIdFieldForAdminProcedure(params.path);
      if (field === null) return unbound;
      const id = targetIdFromInput(field, await params.getRawInput());
      return id === null ? unbound : { kind: targetKindForInputField(field), id };
    },
  };
}

// Admin-only procedure. The creditManager/superadmin/sessionViewer procedures in
// lib/trpc/admin-procedures chain on this, so emitting here covers the whole
// admin.* tRPC surface with a single event. Specialized guards chained on it
// reuse `adminAdmission` and check `adminStepUpDecision` before trusting it
// for their own request.
type AdminGuardFn = Parameters<typeof t.middleware>[0];
const adminGuardFn = markPrivilegedGuard<AdminGuardFn>(
  async ({ ctx, path, type, getRawInput, next }) => {
    const attribution = resolveAdminAttribution(ctx, path, type);
    const isBearer = attribution.credential !== 'session';
    const emitDenied = (ip: string | null = ctx.ip ?? null) =>
      emitPrivilegedAccessEvent({
        surface: 'trpc',
        user: ctx.user,
        credential: attribution.credential,
        outcome: 'denied',
        actionClass: attribution.actionClass,
        actionId: attribution.inventoryId,
        target: null,
        wouldBlock: true,
        userAgentProduct: userAgentProductFromHeaders(ctx.headersList ?? new Headers()),
        tokenSource: ctx.tokenSource ?? null,
        route: path,
        method: type,
        ip,
      });

    const proof = adminProcedureProof({
      path,
      actionClass: attribution.actionClass,
      targetKind: attribution.targetKind,
      getRawInput,
    });
    const result = await admitStaff({
      user: ctx.user,
      credential: ctx.credential,
      webSessionId: ctx.webSessionId,
      webSessionPepper: ctx.webSessionPepper,
      headers: ctx.headersList ?? new Headers(),
      surface: 'trpc',
      route: path,
      method: type,
      actionClass: attribution.actionClass,
      proof,
    });

    if (!result.ok && result.refusal.kind === 'not_staff') {
      if (isBearer) emitDenied();
      throw staffRefusalTrpcError(result.refusal);
    }
    if (!result.ok && result.refusal.kind === 'network') {
      // The network decision's address, never `ctx.ip`: that falls back to the
      // client-settable `x-forwarded-for` when the trusted header is missing.
      if (isBearer) emitDenied(result.refusal.denial.clientAddress);
      throw staffRefusalTrpcError(result.refusal);
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
    if (!result.ok) {
      if (isBearer) emitDenied();
      throw staffRefusalTrpcError(result.refusal);
    }

    const { admission } = result;
    return next({
      ctx: {
        user: admission.user,
        adminAttribution: attribution,
        adminAdmission: admission,
        ...(admission.decision && {
          adminStepUpState: admission.stepUp,
          adminStepUpDecision: admission.decision,
        }),
      },
    });
  },
  'admin'
);

export const adminProcedure = baseProcedure.use(t.middleware(adminGuardFn));
