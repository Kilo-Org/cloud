import 'server-only';
import type { User } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { headers } from 'next/headers';
import { logExceptInTest } from '@/lib/utils.server';

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
 *   - `"support_service"` — the support-service secret called lookup or GDPR
 *     delete. `adminTier` remains a human employee tier (`super_admin` |
 *     `platform_admin`); support events use `"platform_admin"`. `email` /
 *     `kiloUserId` are the service sentinel `"support-automation"`; the CSA
 *     Google actor claim is `claimedActorEmail`. Dashboards that count distinct
 *     admins must exclude `kind:"support_service"`.
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

export type AdminAccessSurface = 'rest' | 'trpc';

export type AdminAccessKind = 'admin_guard' | 'kilo_admin_elevation' | 'support_service';

export type SupportServiceOutcome =
  | 'found'
  | 'not_found'
  | 'enqueued'
  | 'deleted'
  | 'already_deleted'
  | 'refused'
  | 'precondition'
  | 'conflict'
  | 'error';

/**
 * Why an `is_admin` elevation fired. A closed union so the values stay stable
 * and queryable in Axiom, and so a typo cannot silently create a new bucket.
 */
export type KiloAdminElevationReason =
  /** REST `getAuthorizedOrgContext` granted `owner` on an arbitrary org. */
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
  /** MCP gateway org-manager check bypassed for a global admin. */
  | 'mcp_gateway_organization_manage'
  /** Security Agent audit report assembled with Kilo-admin visibility. */
  | 'security_agent_audit_report'
  /** A token carrying `isAdmin` was minted for a downstream service. */
  | 'service_token_mint';

export type AdminAccessEvent = {
  event: 'admin_access';
  surface: AdminAccessSurface;
  kind: AdminAccessKind;
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
   * Best-effort route identifier. For tRPC this is the exact procedure path;
   * for REST it is the concrete pathname (`x-pathname`) when available, falling
   * back to Vercel's matched route pattern (`x-matched-path`), which may be
   * templated (e.g. `/admin/api/users/[id]/...`).
   */
  route: string | null;
  method: string | null;
  ip: string | null;
  /** Set for `kind:"kilo_admin_elevation"`; null for `kind:"admin_guard"`. */
  reason: KiloAdminElevationReason | null;
  /**
   * What the elevation reached, as a `<type>:<id>` reference (see
   * {@link organizationTarget} and friends). Null for `kind:"admin_guard"`,
   * where `route` already identifies the resource.
   */
  target: string | null;
  /**
   * CSA Google actor claim for `kind:"support_service"`. Null for
   * `admin_guard` / elevation events. Not authentication.
   */
  claimedActorEmail: string | null;
  /** Set after a support-service handler knows the result; else null. */
  outcome: SupportServiceOutcome | null;
  /**
   * HMAC-SHA256(`SUPPORT_API_SECRET`, lowercase lookup email). Set on support
   * lookup; null on delete and on non-support events. Comparable only within
   * one secret generation.
   */
  targetEmailHash: string | null;
  /** CSA deletion-request id for `kind:"support_service"`; else null. */
  correlationId: string | null;
};

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

type AdminAccessUser = Pick<User, 'id' | 'google_user_email' | 'is_super_admin'>;

/**
 * Build and emit an `admin_access` event. Called from both admin guard choke
 * points; elevation sites should use {@link elevateViaKiloAdmin} or
 * {@link recordKiloAdminElevation} instead of calling this directly.
 */
export function emitAdminAccessEvent(params: {
  surface: AdminAccessSurface;
  kind: Exclude<AdminAccessKind, 'support_service'>;
  user: AdminAccessUser;
  authViaToken: boolean;
  tokenSource: string | null;
  route: string | null;
  method: string | null;
  ip: string | null;
  reason?: KiloAdminElevationReason | null;
  target?: string | null;
}): void {
  // Audit logging is a side effect that must never deny a legitimate admin
  // action: swallow (and report) any sink failure rather than propagate it.
  try {
    currentSink({
      event: 'admin_access',
      surface: params.surface,
      kind: params.kind,
      kiloUserId: params.user.id,
      email: params.user.google_user_email,
      adminTier: params.user.is_super_admin ? 'super_admin' : 'platform_admin',
      authVia: params.authViaToken ? 'token' : 'session',
      tokenSource: params.tokenSource,
      route: params.route,
      method: params.method,
      ip: params.ip,
      reason: params.reason ?? null,
      target: params.target ?? null,
      claimedActorEmail: null,
      outcome: null,
      targetEmailHash: null,
      correlationId: null,
    });
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_access_log' } });
  }
}

const SUPPORT_AUTOMATION_SENTINEL = 'support-automation';

/**
 * Emit `admin_access` for a support-service secret call. Never throws.
 * Call after the handler knows the result; do not emit on 401 or invalid
 * `actorEmail`.
 */
export function emitSupportServiceAccessEvent(params: {
  method: string;
  route: string | null;
  ip: string | null;
  claimedActorEmail: string;
  correlationId: string;
  outcome: SupportServiceOutcome;
  target: string | null;
  targetEmailHash: string | null;
}): void {
  try {
    currentSink({
      event: 'admin_access',
      surface: 'rest',
      kind: 'support_service',
      kiloUserId: SUPPORT_AUTOMATION_SENTINEL,
      email: SUPPORT_AUTOMATION_SENTINEL,
      adminTier: 'platform_admin',
      authVia: 'token',
      tokenSource: SUPPORT_AUTOMATION_SENTINEL,
      route: params.route,
      method: params.method,
      ip: params.ip,
      reason: null,
      target: params.target,
      claimedActorEmail: params.claimedActorEmail,
      outcome: params.outcome,
      targetEmailHash: params.targetEmailHash,
      correlationId: params.correlationId,
    });
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_access_log' } });
  }
}

/**
 * The audit-relevant slice of a tRPC context. Declared structurally rather than
 * importing `TRPCContext` so this module stays free of a dependency cycle with
 * `@/lib/trpc/init` (which imports from here).
 *
 * `trpcPath`/`trpcType` are populated for every `baseProcedure` descendant by a
 * middleware in `@/lib/trpc/init`; the remaining fields come from
 * `createTRPCContext`. All are optional because the many hand-rolled `{ user }`
 * contexts in REST route handlers, tests, and scripts do not set them, which is
 * also what {@link recordKiloAdminElevation} uses to pick its attribution source.
 */
export type AdminAuditContext = {
  user: AdminAccessUser;
  authViaToken?: boolean;
  tokenSource?: string | null;
  ip?: string | null;
  trpcPath?: string;
  trpcType?: string;
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
  params: { reason: KiloAdminElevationReason; target: string | null }
): Promise<void> {
  if (ctx.trpcPath === undefined) {
    // `tokenSource` can only be preserved when the caller put it on the context,
    // and today's REST handlers pass a bare `{ user }`. That is a deliberate
    // limit, not an oversight: `authVia` — the discriminator that separates a
    // stolen bearer token from a web-console session — is derived from the
    // headers below and is always correct. `tokenSource` only adds granularity
    // *within* the token case, and null is already one of its documented values.
    await recordKiloAdminElevationForRequest({
      user: ctx.user,
      tokenSource: ctx.tokenSource,
      reason: params.reason,
      target: params.target,
    });
    return;
  }
  emitAdminAccessEvent({
    surface: 'trpc',
    kind: 'kilo_admin_elevation',
    user: ctx.user,
    authViaToken: ctx.authViaToken ?? false,
    tokenSource: ctx.tokenSource ?? null,
    route: ctx.trpcPath,
    method: ctx.trpcType ?? null,
    ip: ctx.ip ?? null,
    reason: params.reason,
    target: params.target,
  });
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
    target: string | null;
    grant: TGrant;
  }
): Promise<TGrant> {
  await recordKiloAdminElevation(ctx, { reason: params.reason, target: params.target });
  return params.grant;
}

/**
 * {@link recordKiloAdminElevation} for route handlers and server components,
 * which have request headers instead of a tRPC context. Call it directly from
 * REST-only sites; `recordKiloAdminElevation` also delegates here for the
 * transport-agnostic helpers that REST handlers share with tRPC procedures.
 *
 * Resolves the header store itself so callers cannot forget to. If the store is
 * unavailable — a unit test invoking the surrounding function directly, or a
 * script outside any request — the event is still emitted with null request
 * metadata rather than throwing into the caller's happy path, preserving the
 * rule that audit logging never denies a legitimate admin action.
 */
export async function recordKiloAdminElevationForRequest(params: {
  user: AdminAccessUser;
  tokenSource?: string | null;
  reason: KiloAdminElevationReason;
  target: string | null;
}): Promise<void> {
  let headersList: Headers;
  try {
    headersList = await headers();
  } catch {
    headersList = new Headers();
  }
  recordKiloAdminElevationFromHeaders({ ...params, headersList });
}

function recordKiloAdminElevationFromHeaders(params: {
  user: AdminAccessUser;
  headersList: Headers;
  tokenSource?: string | null;
  reason: KiloAdminElevationReason;
  target: string | null;
}): void {
  emitAdminAccessEvent({
    surface: 'rest',
    kind: 'kilo_admin_elevation',
    user: params.user,
    authViaToken: authViaTokenFromHeaders(params.headersList),
    tokenSource: params.tokenSource ?? null,
    route: routeFromHeaders(params.headersList),
    // No reliable HTTP method header is available here; do not fabricate one.
    method: null,
    ip: clientIpFromHeaders(params.headersList),
    reason: params.reason,
    target: params.target,
  });
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
 * Whether a request authenticated via an API bearer token. Mirrors the exact
 * branch condition in `getUserFromAuth` (truthiness of the `Authorization`
 * header), so the emitted `authVia` label can never diverge from the auth path
 * that was actually taken. This is the compromise discriminator.
 */
export function authViaTokenFromHeaders(headersList: Headers): boolean {
  return Boolean(headersList.get('Authorization'));
}

/**
 * Best-effort route for a REST request: the concrete pathname set by
 * `proxy.ts`, falling back to Vercel's (possibly templated) matched route.
 */
export function routeFromHeaders(headersList: Headers): string | null {
  return headersList.get('x-pathname') ?? headersList.get('x-matched-path') ?? null;
}

/**
 * Extract the client IP from request headers. Prefers `x-forwarded-for`, with
 * `x-vercel-forwarded-for` as a fallback; returns the first hop or null.
 */
export function clientIpFromHeaders(headersList: Headers): string | null {
  const forwarded = headersList.get('x-forwarded-for') ?? headersList.get('x-vercel-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || null;
}
