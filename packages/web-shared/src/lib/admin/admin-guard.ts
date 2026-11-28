import 'server-only';
import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import {
  adminNetworkRefusal,
  type AdminNetworkRefusal,
} from '@kilocode/web-shared/lib/admin/admin-network';
import {
  ADMIN_STEP_UP_ABSENT,
  StepUpRequiredError,
  type AdminStepUpDecision,
  type AdminStepUpState,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type PrivilegedTarget,
  type StepUpSurface,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  BROWSER_SESSION_REQUIRED_MESSAGE,
  runStepUpGuard,
  stepUpRequirement,
} from '@kilocode/web-shared/lib/admin/step-up-guard';

/**
 * How the admission treats the passkey step-up for one request.
 *
 * - `request`: the guard checks the proof now. A session class needs a live
 *   session proof; an operation class claims the one proof minted for this
 *   action class, route, method and target. A target given as a function is
 *   resolved only after the role, network and session checks pass.
 * - `bootstrap`: no proof. Only `stepUp.getStatus` and `POST /api/auth/step-up`
 *   use it, because they exist to report or mint the proof.
 * - `resolver`: no proof here. Only the admin procedures listed in
 *   `ADMIN_STEP_UP_SELF_GUARDED_ROUTES` use it: each resolver resolves its
 *   organization first and then requires a proof bound to it, also when the
 *   switch is off.
 */
/**
 * A caller's own check that this staff request may proceed, such as a live
 * organization or an approved support grant. It receives the current primary
 * row and throws to refuse. It runs after the role, network and session checks
 * and before the proof, so a refused request never spends or asks for one.
 */
export type StaffAuthorization = (currentUser: User) => Promise<void>;

export type StaffProof =
  | {
      kind: 'request';
      target: PrivilegedTarget | (() => Promise<PrivilegedTarget>);
      authorize?: StaffAuthorization;
    }
  | { kind: 'bootstrap' }
  | { kind: 'resolver' };

export type StaffAdmissionRequest = {
  /** The row the transport authenticated. Only its id and role precheck are read. */
  user: User;
  /** The primary row, when the transport already read it for this request. */
  primaryUser?: User;
  /**
   * The provenance the request boundary established. A missing value is not a
   * browser session: a context that did not prove one never gets staff authority.
   */
  credential: PrivilegedCredentialKind | undefined;
  webSessionId: string | null | undefined;
  webSessionPepper: string | null | undefined;
  headers: Headers;
  surface: StepUpSurface;
  route: string | null;
  method: string | null;
  actionClass: PrivilegedActionClass;
  proof: StaffProof;
};

export type StaffAdmission = {
  /** The current primary row: the role, block and session pepper this request acts with. */
  user: User;
  stepUp: AdminStepUpState;
  /** What a `request` proof covered; null for `bootstrap` and `resolver`. */
  decision: AdminStepUpDecision | null;
};

export type StaffRefusal =
  | { kind: 'not_staff' }
  | { kind: 'network'; denial: AdminNetworkRefusal & { clientAddress: string | null } }
  | { kind: 'reauth' }
  /** A UTS browser session: no staff authority until design 5.12 is built for it. */
  | { kind: 'uts_session' }
  | { kind: 'step_up'; cause: StepUpRequiredError; message: string };

export type StaffAdmissionResult =
  | { ok: true; admission: StaffAdmission }
  | { ok: false; refusal: StaffRefusal };

function refused(refusal: StaffRefusal): StaffAdmissionResult {
  return { ok: false, refusal };
}

/**
 * The one admission for staff authority. Ordinary requests never call it.
 *
 * In order: the transport's row must be an admin (no I/O), the network must be
 * allowed, the request must come from a browser session, the primary row must
 * still be an unblocked admin, the session pepper must match that row, and the
 * proof the request names must hold. The network, browser-session and pepper
 * checks do not depend on `ADMIN_STEP_UP_ENABLED`; only the proof does.
 *
 * A legacy browser session without a `webSessionId` is admitted here; a
 * `request` proof then refuses it with `SESSION_UNBOUND` while step-up is on.
 *
 * Returns a refusal for a policy verdict. Throws only for an unexpected failure
 * (a database error, or an operation that cannot name a proof binding).
 */
export async function admitStaff(request: StaffAdmissionRequest): Promise<StaffAdmissionResult> {
  if (!request.user.is_admin) return refused({ kind: 'not_staff' });

  const denial = adminNetworkRefusal(request.headers, {
    route: request.route,
    kiloUserId: request.user.id,
  });
  if (denial) return refused({ kind: 'network', denial });

  // A UTS browser session is refused by name, never treated as a bearer or a NextAuth session.
  if (request.credential === 'uts_session') return refused({ kind: 'uts_session' });
  if (request.credential !== 'session') {
    return refused({
      kind: 'step_up',
      cause: stepUpRequirement({
        code: 'BEARER_NOT_ALLOWED',
        actionClass: request.actionClass,
        operation: null,
      }),
      message: BROWSER_SESSION_REQUIRED_MESSAGE,
    });
  }

  const current = request.primaryUser ?? (await findUserById(request.user.id, db));
  if (
    !current ||
    current.id !== request.user.id ||
    isBlockedAccount(current) ||
    !current.is_admin
  ) {
    return refused({ kind: 'not_staff' });
  }
  if (!isWebSessionCurrent(request.webSessionPepper, current)) {
    return refused({ kind: 'reauth' });
  }

  const { proof } = request;
  if (proof.kind !== 'request') {
    return { ok: true, admission: { user: current, stepUp: ADMIN_STEP_UP_ABSENT, decision: null } };
  }

  await proof.authorize?.(current);
  const target = typeof proof.target === 'function' ? await proof.target() : proof.target;
  try {
    const stepUp = await runStepUpGuard({
      userId: current.id,
      credential: 'session',
      webSessionId: request.webSessionId,
      actionClass: request.actionClass,
      target,
      enabled: isAdminStepUpEnabled(),
      route: request.route,
      method: request.method,
      surface: request.surface,
    });
    return {
      ok: true,
      admission: {
        user: current,
        stepUp,
        decision: { actionClass: request.actionClass, target },
      },
    };
  } catch (error) {
    if (error instanceof TRPCError && error.cause instanceof StepUpRequiredError) {
      return refused({ kind: 'step_up', cause: error.cause, message: error.message });
    }
    throw error;
  }
}

/**
 * Cause of a staff refusal that is not a step-up refusal, so a handler can
 * recognize it without comparing messages. The tRPC error formatter does not
 * expose it; a step-up refusal keeps `StepUpRequiredError` as its cause, which
 * the formatter publishes as `data.stepUp`.
 */
export class StaffRefusalCause extends Error {
  readonly kind: StaffRefusalKind;

  constructor(kind: StaffRefusalKind) {
    super(kind);
    this.name = 'StaffRefusalCause';
    this.kind = kind;
  }
}

type StaffRefusalKind = Exclude<StaffRefusal['kind'], 'step_up'> | 'different_operation';

/**
 * Which staff admission refusal a tRPC error is, or null when it is not one.
 * A step-up refusal from any guard reports `step_up`.
 */
export function staffRefusalKind(error: unknown): StaffRefusalKind | 'step_up' | null {
  if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') return null;
  if (error.cause instanceof StepUpRequiredError) return 'step_up';
  if (error.cause instanceof StaffRefusalCause) return error.cause.kind;
  return null;
}

/**
 * The refusal for a request whose measured step-up decision does not cover the
 * action, target or operation a later guard in the same request names. One
 * request is evaluated once, so it is never asked for a second proof.
 */
export function differentOperationError(): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'This request was verified for a different operation',
    cause: new StaffRefusalCause('different_operation'),
  });
}

/** The tRPC refusal for a staff admission, in the shapes `adminProcedure` has always used. */
export function staffRefusalTrpcError(refusal: StaffRefusal): TRPCError {
  switch (refusal.kind) {
    case 'not_staff':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access required',
        cause: new StaffRefusalCause('not_staff'),
      });
    case 'network':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: refusal.denial.message,
        cause: new StaffRefusalCause('network'),
      });
    case 'reauth':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'Reauthentication required',
        cause: new StaffRefusalCause('reauth'),
      });
    case 'uts_session':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access requires a staff sign-in session',
        cause: new StaffRefusalCause('uts_session'),
      });
    case 'step_up':
      return new TRPCError({ code: 'FORBIDDEN', message: refusal.message, cause: refusal.cause });
  }
}
