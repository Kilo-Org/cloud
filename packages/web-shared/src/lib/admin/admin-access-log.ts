import 'server-only';
import type { User } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { headers } from 'next/headers';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type {
  PrivilegedActionClass,
  PrivilegedCredentialKind,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import type { SupportDecision } from '@kilocode/web-shared/lib/admin/support-access';
import { deriveCredentialKind } from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * Per-request, identity-attributed audit telemetry for Kilocode admin access.
 *
 * This is structured-log telemetry (shipped to the Axiom `vercel` dataset via
 * stdout, same mechanism as `admin_login_succeeded`), NOT a database table. It
 * closes the blind spot where a compromised admin API token could read data
 * leaving only anonymous edge request logs.
 *
 * Every event carries two orthogonal, always-present dimensions so a single
 * `event:"admin_access"` query returns the whole picture and can then be split:
 *
 * `surface` — how the request arrived:
 *   - `"rest"` — a Next.js route handler (`/admin/api/*`, `/api/*`).
 *   - `"trpc"` — a tRPC procedure.
 *   - `"server-component"` — a React server component render (a page, a layout,
 *     or a server action), which has request headers but no tRPC context.
 *
 * `kind` — what produced the event (three values):
 *   - `"admin_guard"` — an explicit admin gate was satisfied. Emitted at the two
 *     choke points that protect the `/admin` console: `getUserFromAuth` with
 *     `adminOnly: true`, and the `adminProcedure` middleware.
 *   - `"kilo_admin_elevation"` — the `is_admin` escape hatch granted a Kilo
 *     employee access to *customer* data on an otherwise non-admin code path
 *     (e.g. reading any organization, querying sessions across all orgs). These
 *     paths pass through neither admin gate, so they emit here instead. Carries
 *     a `reason` and a `target`.
 *   - `"privileged_access"` — observe-only measurement of a bearer credential
 *     exercising a privileged action. Carries `credential`, `outcome`,
 *     `actionClass`, and `wouldBlock`.
 *
 * Coverage note: `kind:"admin_guard"` alone covers only the `/admin` console
 * surface. Kilo's highest-value admin capability — an employee reading an
 * arbitrary customer organization's data — flows through `is_admin` checks on
 * regular procedures and is covered by `kind:"kilo_admin_elevation"`. Any new
 * `is_admin` bypass must funnel through {@link elevateViaKiloAdmin} or
 * {@link recordKiloAdminElevation}, or it will be invisible to this audit trail.
 *
 * Security: never include the token itself, the Authorization header, cookies,
 * or any secret in this event.
 */

export type AdminAccessSurface = 'rest' | 'trpc' | 'server-component';

/**
 * Why an `is_admin` elevation fired. A closed union so the values stay stable
 * and queryable in Axiom, and so a typo cannot silently create a new bucket.
 */
export type KiloAdminElevationReason =
  /**
   * `getAuthorizedOrgContext` granted `owner` on an arbitrary org. The `_rest`
   * suffix is historical: the helper is called from route handlers (default
   * surface `"rest"`) and from server components (`"server-component"`), and the
   * event's `surface` is what distinguishes them.
   */
  | 'organization_access_rest'
  /** tRPC `ensureOrganizationAccess` granted `owner` on an arbitrary org. */
  | 'organization_access'
  /** tRPC `getOrganizationsAccessRoles` granted `owner` on a batch of orgs. */
  | 'organization_access_batch'
  /** tRPC `ensureOrganizationAccessAndFetchOrg` returned an arbitrary org. */
  | 'organization_fetch'
  /** CLI session query ran with the org-membership filter removed entirely. */
  | 'cli_session_cross_org_query'
  /** Code-index read/write redirected to another org or user via `overrideUser`. */
  | 'code_index_user_override'
  /** Security Agent audit report assembled with Kilo-admin visibility. */
  | 'security_agent_audit_report'
  /** A token carrying `isAdmin` was minted for a downstream service. */
  | 'service_token_mint'
  /** A delegated resource token carrying `isAdmin` was minted for a Worker. */
  | 'delegated_resource_token_mint'
  /** A short-lived Worker admin capability was minted for a service. */
  | 'worker_capability_mint';

/** Fields every `admin_access` event carries, whatever produced it. */
export type AdminAccessAttribution = {
  event: 'admin_access';
  surface: AdminAccessSurface;
  kiloUserId: string;
  email: string;
  adminTier: 'super_admin' | 'platform_admin';
  /**
   * `"token"` when the request authenticated via an API bearer token (any
   * `Authorization` header), else `"session"` (web-console cookie). This is the
   * compromise discriminator; `tokenSource` below adds finer granularity.
   */
  authVia: 'token' | 'session';
  /** Set only for tokens that carry a source (e.g. `cloud-agent`); else null. */
  tokenSource: string | null;
  /**
   * How the credential was obtained, not just how it arrived. `authVia` still
   * separates bearer from session; this separates a personal key from a bot, a
   * delegated workload, and a service assertion.
   */
  credential: PrivilegedCredentialKind;
  /** The actor's real role in the target organization, when one was measured. */
  membershipRole: string | null;
  /**
   * Whether the actor's own membership would have authorized the action without
   * the `is_admin` escape hatch. Null when the site cannot measure it.
   */
  wouldPassWithoutAdmin: boolean | null;
  /**
   * Observe-only sizing: a bearer credential on a privileged action would be
   * blocked once session-only enforcement is applied.
   */
  wouldBlock: boolean;
  /** First product token of the User-Agent only, never the full string. */
  userAgentProduct: string | null;
  /** Capability issuance id (`jti`) when the event records a capability mint. */
  issuanceId: string | null;
  /**
   * Best-effort route identifier. For tRPC this is the exact procedure path;
   * for REST and server components it is the concrete pathname (`x-pathname`)
   * when available, falling back to Vercel's matched route pattern
   * (`x-matched-path`), which may be templated (e.g. `/admin/api/users/[id]/...`).
   */
  route: string | null;
  /**
   * The tRPC operation type (`query`, `mutation`) on `surface:"trpc"`; the HTTP
   * method on `surface:"rest"`, forwarded by `proxy.ts` as `x-http-method`.
   * Null when no reliable value exists (for example a unit test that invokes a
   * shared helper without the proxy).
   */
  method: string | null;
  ip: string | null;
  /** Resolution verdict for explicit support-organization access. */
  supportDecision: SupportDecision | null;
  supportGrantId: string | null;
  supportActionId: string | null;
  inventoryId: string | null;
};

/**
 * Privileged-access attribution. Identity is nullable because a bearer request
 * can be refused before any user is resolved; the credential, route, and
 * outcome are still worth alerting on.
 */
export type PrivilegedAccessAttribution = Omit<
  AdminAccessAttribution,
  'kiloUserId' | 'email' | 'adminTier'
> & {
  kiloUserId: string | null;
  email: string | null;
  adminTier: 'super_admin' | 'platform_admin' | null;
};

/**
 * Discriminated on `kind`, so the documented correlation is enforced by the
 * compiler: a guard event cannot carry elevation attribution, and an elevation
 * always names its reason and target.
 */
export type AdminAccessEvent =
  | (AdminAccessAttribution & {
      kind: 'admin_guard';
      reason: null;
      target: null;
    })
  | (AdminAccessAttribution & {
      kind: 'kilo_admin_elevation';
      /** Why the `is_admin` escape hatch fired. */
      reason: KiloAdminElevationReason;
      /**
       * What the elevation reached, as a `<type>:<id>` reference (see
       * {@link organizationTarget} and friends), or {@link UNSCOPED_TARGET}
       * when the elevation is not scoped to any single resource.
       */
      target: string;
    })
  | (PrivilegedAccessAttribution & {
      /**
       * Measurement for privileged access. Emitted for bearer credentials only,
       * so a stolen API key is visible even when the request is denied. Session
       * traffic stays on `admin_guard` / `kilo_admin_elevation`.
       */
      kind: 'privileged_access';
      credential: PrivilegedCredentialKind;
      outcome: 'succeeded' | 'denied' | 'failed';
      actionClass: PrivilegedActionClass;
      actionId: string | null;
      target: string | null;
    });

/** The `kind` discriminant of {@link AdminAccessEvent}. */
export type AdminAccessKind = AdminAccessEvent['kind'];

export type AdminAccessSink = (event: AdminAccessEvent) => void;

const defaultSink: AdminAccessSink = event => logExceptInTest(JSON.stringify(event));

let currentSink: AdminAccessSink = defaultSink;

/**
 * Test-only seam. `logExceptInTest` is a no-op in automated tests, so a test
 * cannot observe the default sink. Override it to capture emitted events, and
 * pass `null` to restore the production sink.
 */
export function setAdminAccessSinkForTest(sink: AdminAccessSink | null): void {
  currentSink = sink ?? defaultSink;
}

type AdminAccessUser = Pick<User, 'id' | 'google_user_email' | 'is_super_admin' | 'is_admin'>;

/**
 * Input of {@link emitAdminAccessEvent}: the transport and identity fields plus
 * the same `kind`-discriminated attribution as {@link AdminAccessEvent}. A guard
 * caller cannot pass a `reason` or `target`, and an elevation caller cannot omit
 * them.
 */
export type AdminAccessEventInput = {
  surface: AdminAccessSurface;
  authViaToken: boolean;
  tokenSource: string | null;
  credential?: PrivilegedCredentialKind;
  membershipRole?: string | null;
  wouldPassWithoutAdmin?: boolean | null;
  wouldBlock?: boolean;
  userAgentProduct?: string | null;
  route: string | null;
  method: string | null;
  ip: string | null;
  supportDecision?: SupportDecision | null;
  supportGrantId?: string | null;
  supportActionId?: string | null;
  inventoryId?: string | null;
} & (
  | { kind: 'admin_guard'; user: AdminAccessUser }
  | {
      kind: 'kilo_admin_elevation';
      user: AdminAccessUser;
      reason: KiloAdminElevationReason;
      target: string;
      issuanceId?: string | null;
    }
  | {
      kind: 'privileged_access';
      /** Null when the credential was refused before a user could be resolved. */
      user?: AdminAccessUser;
      credential: PrivilegedCredentialKind;
      outcome: 'succeeded' | 'denied' | 'failed';
      actionClass: PrivilegedActionClass;
      actionId?: string | null;
      target?: string | null;
    }
);

export type PrivilegedAccessEventInput = {
  surface: AdminAccessSurface;
  user?: AdminAccessUser;
  credential: PrivilegedCredentialKind;
  outcome: 'succeeded' | 'denied' | 'failed';
  actionClass: PrivilegedActionClass;
  actionId?: string | null;
  target?: string | null;
  wouldBlock?: boolean;
  userAgentProduct?: string | null;
  tokenSource: string | null;
  route: string | null;
  method: string | null;
  ip: string | null;
};

/**
 * Build and emit an `admin_access` event. Called from both admin guard choke
 * points; elevation sites should use {@link elevateViaKiloAdmin} or
 * {@link recordKiloAdminElevation} instead of calling this directly.
 */
export function emitAdminAccessEvent(params: AdminAccessEventInput): void {
  const credential =
    params.credential ??
    deriveCredentialKind({
      authViaToken: params.authViaToken,
      tokenSource: params.tokenSource,
    });
  const transport = {
    authVia: params.authViaToken ? ('token' as const) : ('session' as const),
    tokenSource: params.tokenSource,
    credential,
    membershipRole: params.membershipRole ?? null,
    wouldPassWithoutAdmin: params.wouldPassWithoutAdmin ?? null,
    wouldBlock: params.wouldBlock ?? credential !== 'session',
    userAgentProduct: params.userAgentProduct ?? null,
    route: params.route,
    method: params.method,
    ip: params.ip,
    supportDecision: params.supportDecision ?? null,
    supportGrantId: params.supportGrantId ?? null,
    supportActionId: params.supportActionId ?? null,
    inventoryId: params.inventoryId ?? null,
  };
  // Audit logging is a side effect that must never deny a legitimate admin
  // action: swallow (and report) any sink failure rather than propagate it.
  try {
    if (params.kind === 'kilo_admin_elevation') {
      currentSink({
        event: 'admin_access',
        surface: params.surface,
        kind: 'kilo_admin_elevation',
        ...attributionFor(params.user),
        ...transport,
        reason: params.reason,
        target: params.target,
        issuanceId: params.issuanceId ?? null,
      });
    } else if (params.kind === 'privileged_access') {
      currentSink({
        event: 'admin_access',
        surface: params.surface,
        kind: 'privileged_access',
        ...nullableAttributionFor(params.user),
        ...transport,
        issuanceId: null,
        credential: params.credential,
        outcome: params.outcome,
        actionClass: params.actionClass,
        actionId: params.actionId ?? null,
        target: params.target ?? null,
      });
    } else {
      currentSink({
        event: 'admin_access',
        surface: params.surface,
        kind: 'admin_guard',
        ...attributionFor(params.user),
        ...transport,
        issuanceId: null,
        reason: null,
        target: null,
      });
    }
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_access_log' } });
  }
}

function attributionFor(user: AdminAccessUser) {
  return {
    kiloUserId: user.id,
    email: user.google_user_email,
    adminTier: user.is_super_admin ? ('super_admin' as const) : ('platform_admin' as const),
  };
}

function nullableAttributionFor(user: AdminAccessUser | undefined) {
  const adminTier = user?.is_super_admin
    ? ('super_admin' as const)
    : user?.is_admin
      ? ('platform_admin' as const)
      : null;
  return {
    kiloUserId: user?.id ?? null,
    email: user?.is_admin ? user.google_user_email : null,
    adminTier,
  };
}

/**
 * Emit one observe-only `privileged_access` event. It never denies; it exists
 * so a bearer credential exercising platform authority is alertable while it is
 * still allowed.
 */
export function emitPrivilegedAccessEvent(params: PrivilegedAccessEventInput): void {
  emitAdminAccessEvent({
    ...params,
    kind: 'privileged_access',
    authViaToken: params.credential !== 'session',
  });
}

/**
 * The audit-relevant slice of a tRPC context. Declared structurally rather than
 * importing `TRPCContext` so this module stays free of a dependency cycle with
 * `@kilocode/web-shared/lib/trpc/init` (which imports from here).
 *
 * `trpcPath`/`trpcType` are populated for every `baseProcedure` descendant by a
 * middleware in `@kilocode/web-shared/lib/trpc/init`; the remaining fields come from
 * `createTRPCContext`. All are optional because the many hand-rolled `{ user }`
 * contexts in REST route handlers, tests, and scripts do not set them, which is
 * also what {@link recordKiloAdminElevation} uses to pick its attribution source.
 */
export type AdminAuditContext = {
  user: AdminAccessUser;
  authViaToken?: boolean;
  tokenSource?: string | null;
  /** Provenance derived once at the tRPC boundary, when available. */
  credential?: PrivilegedCredentialKind;
  internalApiUse?: boolean;
  ip?: string | null;
  headersList?: Headers;
  trpcPath?: string;
  trpcType?: string;
  /** REST/server-component surface when the caller already knows it. */
  auditSurface?: AdminAccessSurface;
  /** Actual request method for a REST caller. */
  auditMethod?: string;
  delegatedWorkload?: boolean;
};

/** Membership observation carried by an elevation event. */
export type ElevationMembershipObservation = {
  /** The actor's real role in the target org, when measured. */
  membershipRole?: string | null;
  /** Whether that real role alone would have authorized the request. */
  wouldPassWithoutAdmin?: boolean | null;
};

/**
 * Record that the `is_admin` escape hatch granted a Kilo employee access to
 * data they have no membership-derived right to, on a code path that does not
 * pass through `adminProcedure`.
 *
 * Call this from inside the `is_admin` branch, before returning the elevated
 * result, so the access is recorded even if the caller later throws. Prefer
 * {@link elevateViaKiloAdmin} where the branch produces a value.
 *
 * Surface-agnostic on purpose. Several elevation sites live in helpers that are
 * shared between tRPC procedures and REST route handlers — `ensureOrganizationAccess`
 * is called both from `organizationMemberProcedure` and from route handlers such
 * as `/api/cloud-agent/sessions/stream-ticket`, which hand-roll a `{ user }`
 * context. A context carrying `trpcPath` is attributed from the context; anything
 * else is attributed from the request headers, so a REST caller is not mislabeled
 * as a tRPC session request. That distinction matters most for `authVia`: guessing
 * `"session"` for a bearer-token request would silently break the compromise
 * discriminator this whole event exists to provide.
 */
export async function recordKiloAdminElevation(
  ctx: AdminAuditContext,
  params: {
    reason: KiloAdminElevationReason;
    target: string;
    supportDecision?: SupportDecision | null;
    supportGrantId?: string | null;
    supportActionId?: string | null;
    inventoryId?: string | null;
    issuanceId?: string | null;
  } & ElevationMembershipObservation
): Promise<void> {
  if (ctx.trpcPath === undefined) {
    // `tokenSource` is only preserved when the caller put it on the context.
    // Some REST handlers still pass a bare `{ user }`, and their events carry
    // null. `authVia` — the discriminator that separates a stolen bearer token
    // from a web-console session — is derived from the request headers below and
    // is always correct. `tokenSource` only adds granularity *within* the token
    // case, and null is already one of its documented values.
    await recordKiloAdminElevationForRequest({
      user: ctx.user,
      tokenSource: ctx.tokenSource,
      internalApiUse: ctx.internalApiUse,
      reason: params.reason,
      target: params.target,
      surface: ctx.auditSurface,
      method: ctx.auditMethod,
      delegatedWorkload: ctx.delegatedWorkload,
      membershipRole: params.membershipRole,
      wouldPassWithoutAdmin: params.wouldPassWithoutAdmin,
      supportDecision: params.supportDecision,
      supportGrantId: params.supportGrantId,
      supportActionId: params.supportActionId,
      inventoryId: params.inventoryId,
      issuanceId: params.issuanceId,
    });
    return;
  }
  const credential =
    ctx.credential ??
    deriveCredentialKind({
      authViaToken: ctx.authViaToken ?? false,
      tokenSource: ctx.tokenSource ?? null,
    });
  emitAdminAccessEvent({
    surface: 'trpc',
    kind: 'kilo_admin_elevation',
    user: ctx.user,
    authViaToken: ctx.authViaToken ?? false,
    tokenSource: ctx.tokenSource ?? null,
    credential,
    membershipRole: params.membershipRole ?? null,
    wouldPassWithoutAdmin: params.wouldPassWithoutAdmin ?? null,
    wouldBlock: credential !== 'session',
    userAgentProduct: ctx.headersList ? userAgentProductFromHeaders(ctx.headersList) : null,
    route: ctx.trpcPath,
    method: ctx.trpcType ?? null,
    ip: ctx.ip ?? null,
    reason: params.reason,
    target: params.target,
    supportDecision: params.supportDecision,
    supportGrantId: params.supportGrantId,
    supportActionId: params.supportActionId,
    inventoryId: params.inventoryId,
    issuanceId: params.issuanceId ?? null,
  });
  if (ctx.authViaToken) {
    emitPrivilegedAccessEvent({
      surface: 'trpc',
      user: ctx.user,
      credential,
      outcome: 'succeeded',
      actionClass: actionClassForElevation(params.reason, ctx.trpcType ?? null),
      actionId: null,
      target: params.target,
      wouldBlock: true,
      userAgentProduct: ctx.headersList ? userAgentProductFromHeaders(ctx.headersList) : null,
      tokenSource: ctx.tokenSource ?? null,
      route: ctx.trpcPath,
      method: ctx.trpcType ?? null,
      ip: ctx.ip ?? null,
    });
  }
}

/**
 * {@link recordKiloAdminElevation} for `is_admin` branches that return an
 * elevated value: emits the audit event and hands back `grant`, so the
 * elevation and its audit record are a single expression.
 *
 *     if (ctx.user.is_admin) {
 *       return await elevateViaKiloAdmin(ctx, {
 *         reason: 'organization_access',
 *         target: organizationTarget(organizationId),
 *         grant: 'owner',
 *       });
 *     }
 */
export async function elevateViaKiloAdmin<const TGrant>(
  ctx: AdminAuditContext,
  params: {
    reason: KiloAdminElevationReason;
    /** See {@link organizationTarget} and {@link UNSCOPED_TARGET}. */
    target: string;
    grant: TGrant;
    issuanceId?: string | null;
  } & ElevationMembershipObservation
): Promise<TGrant> {
  await recordKiloAdminElevation(ctx, {
    reason: params.reason,
    target: params.target,
    membershipRole: params.membershipRole,
    wouldPassWithoutAdmin: params.wouldPassWithoutAdmin,
    issuanceId: params.issuanceId,
  });
  return params.grant;
}

/**
 * {@link recordKiloAdminElevation} for route handlers and server components,
 * which have request headers instead of a tRPC context. Call it directly from
 * REST-only sites; `recordKiloAdminElevation` also delegates here for the
 * transport-agnostic helpers that REST handlers share with tRPC procedures.
 *
 * `surface` says how the request arrived, and defaults to `'rest'` because route
 * handlers are the common caller. Server components pass `'server-component'`,
 * so their events are not labelled as route handlers.
 *
 * Resolves the header store itself so callers cannot forget to. If the store is
 * unavailable — a unit test invoking the surrounding function directly, or a
 * script outside any request — the event is still emitted with null request
 * metadata rather than throwing into the caller's happy path, preserving the
 * rule that audit logging never denies a legitimate admin action.
 */
export async function recordKiloAdminElevationForRequest(
  params: {
    user: AdminAccessUser;
    tokenSource?: string | null;
    reason: KiloAdminElevationReason;
    target: string;
    surface?: AdminAccessSurface;
    /** The actual Request method when the caller has one. */
    method?: string;
    /** Use the caller's request headers instead of the ambient header store. */
    headersList?: Headers;
    internalApiUse?: boolean;
    delegatedWorkload?: boolean;
    supportDecision?: SupportDecision | null;
    supportGrantId?: string | null;
    supportActionId?: string | null;
    inventoryId?: string | null;
    issuanceId?: string | null;
  } & ElevationMembershipObservation
): Promise<void> {
  let headersList = params.headersList;
  if (!headersList) {
    try {
      headersList = await headers();
    } catch {
      headersList = new Headers();
    }
  }
  recordKiloAdminElevationFromHeaders({ ...params, headersList });
}

function recordKiloAdminElevationFromHeaders(
  params: {
    user: AdminAccessUser;
    headersList: Headers;
    tokenSource?: string | null;
    reason: KiloAdminElevationReason;
    target: string;
    surface?: AdminAccessSurface;
    method?: string;
    internalApiUse?: boolean;
    delegatedWorkload?: boolean;
    supportDecision?: SupportDecision | null;
    supportGrantId?: string | null;
    supportActionId?: string | null;
    inventoryId?: string | null;
    issuanceId?: string | null;
  } & ElevationMembershipObservation
): void {
  const authViaToken = authViaTokenFromHeaders(params.headersList);
  const route = routeFromHeaders(params.headersList);
  const method = params.method ?? methodFromHeaders(params.headersList);
  const credential = deriveCredentialKind({
    authViaToken,
    tokenSource: params.tokenSource ?? null,
    internalApiUse: params.internalApiUse,
    delegatedWorkload: params.delegatedWorkload,
  });
  emitAdminAccessEvent({
    surface: params.surface ?? 'rest',
    kind: 'kilo_admin_elevation',
    user: params.user,
    authViaToken,
    tokenSource: params.tokenSource ?? null,
    credential,
    membershipRole: params.membershipRole ?? null,
    wouldPassWithoutAdmin: params.wouldPassWithoutAdmin ?? null,
    wouldBlock: credential !== 'session',
    route,
    method,
    userAgentProduct: userAgentProductFromHeaders(params.headersList),
    ip: clientIpFromHeaders(params.headersList),
    reason: params.reason,
    target: params.target,
    supportDecision: params.supportDecision,
    supportGrantId: params.supportGrantId,
    supportActionId: params.supportActionId,
    inventoryId: params.inventoryId,
    issuanceId: params.issuanceId ?? null,
  });
  if (authViaToken) {
    emitPrivilegedAccessEvent({
      surface: params.surface ?? 'rest',
      user: params.user,
      credential,
      outcome: 'succeeded',
      actionClass: actionClassForElevation(params.reason, method),
      actionId: null,
      target: params.target,
      wouldBlock: true,
      userAgentProduct: userAgentProductFromHeaders(params.headersList),
      tokenSource: params.tokenSource ?? null,
      route,
      method,
      ip: clientIpFromHeaders(params.headersList),
    });
  }
}

function actionClassForElevation(
  reason: KiloAdminElevationReason,
  method: string | null
): PrivilegedActionClass {
  switch (reason) {
    case 'organization_access_batch':
    case 'organization_fetch':
    case 'cli_session_cross_org_query':
    case 'security_agent_audit_report':
      return 'support_read';
    case 'organization_access':
      return method === 'mutation' ? 'support_write' : 'support_read';
    case 'organization_access_rest':
      return method === 'GET' || method === 'HEAD' ? 'support_read' : 'support_write';
    case 'code_index_user_override':
      return 'support_write';
    case 'service_token_mint':
    case 'delegated_resource_token_mint':
    case 'worker_capability_mint':
      return 'worker_admin';
  }
}

/** `target` for a single organization. */
export function organizationTarget(organizationId: string): string {
  return `organization:${organizationId}`;
}

/**
 * `target` for a batch of organizations. Names the org when there is exactly
 * one, otherwise records the count — the audit-relevant fact for a bulk role
 * resolution is the breadth, and inlining hundreds of UUIDs would bloat the log
 * line past what the drain will keep.
 */
export function organizationsTarget(organizationIds: readonly string[]): string {
  const unique = Array.from(new Set(organizationIds));
  const [only] = unique;
  return unique.length === 1 && only !== undefined
    ? organizationTarget(only)
    : `organizations:${unique.length}`;
}

/** `target` for a single Kilo user. */
export function userTarget(userId: string): string {
  return `user:${userId}`;
}

/** `target` for a downstream service that a minted token grants access to. */
export function serviceTarget(service: string): string {
  return `service:${service}`;
}

/** `target` for an elevation that is not scoped to any single resource. */
export const UNSCOPED_TARGET = '*';

/**
 * Whether a request carries an API bearer credential. Any `Authorization`
 * header counts, including an empty or malformed one: `getUserFromAuth` takes
 * its bearer branch whenever the header is present and never falls back to the
 * cookie, so the discriminator must use presence rather than truthiness.
 */
export function authViaTokenFromHeaders(headersList: Headers): boolean {
  return headersList.has('authorization');
}

/**
 * Best-effort route for a REST request: the concrete pathname set by
 * `proxy.ts`, falling back to Vercel's (possibly templated) matched route.
 */
export function routeFromHeaders(headersList: Headers): string | null {
  return headersList.get('x-pathname') ?? headersList.get('x-matched-path') ?? null;
}

/**
 * HTTP method forwarded by `proxy.ts`. Route handlers have the Request, but the
 * shared auth/audit helpers only receive headers.
 */
export function methodFromHeaders(
  headersList: Headers,
  requestMethod?: string | null
): string | null {
  if (requestMethod) return requestMethod.toUpperCase();
  const method = headersList.get('x-http-method');
  return method === null || method === '' ? null : method.toUpperCase();
}

/**
 * The first product token of the User-Agent (`Mozilla/5.0`, `kilo-cli/1.2`),
 * never the full header. Null when absent.
 */
export function userAgentProductFromHeaders(headersList: Headers): string | null {
  const userAgent = headersList.get('user-agent');
  if (userAgent === null) return null;
  const first = userAgent.trim().split(/\s+/, 1)[0];
  if (first === '') return null;
  return first.slice(0, 64);
}

/**
 * The usable first hop of a forwarding header, or null when the header is
 * absent or its first entry is empty.
 */
function firstForwardedHop(forwarded: string | null): string | null {
  if (forwarded === null) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}

/**
 * Extract the client IP from request headers.
 *
 * `x-vercel-forwarded-for` is the address the platform observed, so it is read
 * first: `x-forwarded-for` can be rewritten by a proxy in front of the platform.
 * `x-forwarded-for` is the fallback for a request the platform did not label
 * (local development, a direct origin hit). Null when neither header carries a
 * usable hop, so the event records an explicitly unavailable address.
 */
export function clientIpFromHeaders(headersList: Headers): string | null {
  return (
    firstForwardedHop(headersList.get('x-vercel-forwarded-for')) ??
    firstForwardedHop(headersList.get('x-forwarded-for'))
  );
}
