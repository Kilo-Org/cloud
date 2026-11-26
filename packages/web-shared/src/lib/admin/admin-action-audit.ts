import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  admin_action_audit_logs,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { ORGANIZATION_PARENT_ACCESS_ROLES } from '@kilocode/app-shared/organizations';
import { and, eq, inArray } from 'drizzle-orm';
import {
  AdminActionAuditAction,
  type AdminActionAuditOutcome,
  type AdminActionAuditTargetType,
} from '@kilocode/db/schema-types';
import {
  adminTierFor,
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  routeFromHeaders,
  type AdminAccessAttribution,
  type AdminAuditContext,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  privilegedGuardTiers,
  targetIdFromInput,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Durable, identity-attributed record of a platform admin action.
 *
 * Every entry is written to `admin_action_audit_logs` and emitted in an
 * `event:"admin_action"` structured log line (Axiom `vercel` dataset): one line
 * per single-entry call, one line per stored insert chunk for a bulk call (see
 * {@link AdminActionBulkEvent}), and one line per entry of a chunk that was not
 * stored, so the log keeps everything the missing rows would hold. The table is
 * browsable in the admin console and pruned after the retention window; the
 * log line carries request metadata (IP, auth source) that the table
 * deliberately does not store.
 *
 * Record after the action has resolved: a success entry once it succeeded, a
 * failure entry (with a stable `errorCode`, never an error message) once it
 * failed. A failed audit write is reported and flagged with `persisted:false`
 * in the log line, but never thrown: the action has already happened, and
 * failing the request would invite a retry of a non-idempotent operation.
 *
 * Admin tRPC mutations and admin REST write handlers run inside an audit
 * scope ({@link runAdminAuditScope}) declared by an {@link AdminAuditSpec}. The
 * scope records the success row itself for a declarative spec, records a
 * failure row whenever the action fails, and reports a handler-recorded action
 * that finished without recording anything.
 *
 * `message` and `metadata` are stored and logged verbatim. Never include
 * tokens, credentials, or customer email addresses; reference users and
 * organizations by ID through `target`. Operator-typed free text can name a
 * customer, so pass it through {@link redactEmailAddressesInAuditText} before it
 * becomes part of an entry.
 */

export type AdminActionContext = Omit<AdminAuditContext, 'user'> & {
  user: Pick<User, 'id' | 'google_user_email' | 'google_user_name' | 'is_super_admin'>;
};

export type AdminActionTarget = {
  type: AdminActionAuditTargetType;
  id: string;
};

type AdminActionEntryFields = {
  action: AdminActionAuditAction;
  target: AdminActionTarget | null;
  message: string;
  metadata?: Record<string, unknown>;
};

/**
 * One audited action. A failure entry names a stable `errorCode` (a
 * `TRPCError` code, an HTTP status, or an error class name), which is stored
 * as `metadata.errorCode`; never put the error message there.
 */
export type AdminActionEntry = AdminActionEntryFields &
  ({ outcome?: 'success' } | { outcome: 'failure'; errorCode: string });

type AdminActionEventAttribution = Pick<
  AdminAccessAttribution,
  'kiloUserId' | 'email' | 'adminTier' | 'authVia' | 'tokenSource' | 'route' | 'ip'
>;

/** The log line of a call that records one entry. */
export type AdminActionEntryEvent = AdminActionEventAttribution & {
  event: 'admin_action';
  action: AdminActionAuditAction;
  outcome: AdminActionAuditOutcome;
  auditLogId: string | null;
  persisted: boolean;
  targetType: AdminActionAuditTargetType | null;
  targetId: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
};

/**
 * The log line of a call that records several entries: one per stored insert
 * chunk and action/outcome pair, listing the row ids and target ids in entry
 * order. `targetType`, `message` and `metadata` are set when every listed
 * entry shares them and null otherwise; the rows hold each entry's own values.
 * A failure line lists each entry's `errorCode` in `errorCodes`, aligned with
 * `targetIds`; a success line has `errorCodes: null`. A chunk whose insert
 * failed is logged one {@link AdminActionEntryEvent} per entry instead.
 */
export type AdminActionBulkEvent = AdminActionEventAttribution & {
  event: 'admin_action';
  action: AdminActionAuditAction;
  outcome: AdminActionAuditOutcome;
  entryCount: number;
  auditLogIds: string[];
  persisted: true;
  targetType: AdminActionAuditTargetType | null;
  targetIds: (string | null)[];
  errorCodes: string[] | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
};

export type AdminActionEvent = AdminActionEntryEvent | AdminActionBulkEvent;

// Stays well under PostgreSQL's 65,535 bind-parameter limit for bulk actions,
// and keeps a bulk log line's id and code arrays far below Vercel's 256 KB line limit.
const INSERT_CHUNK_SIZE = 1_000;

export type AdminActionSink = (event: AdminActionEvent) => void;

const defaultSink: AdminActionSink = event => logExceptInTest(JSON.stringify(event));

let currentSink: AdminActionSink = defaultSink;

/** Test-only seam; pass `null` to restore the production sink. */
export function setAdminActionSinkForTest(sink: AdminActionSink | null): void {
  currentSink = sink ?? defaultSink;
}

export async function recordAdminAction(
  ctx: AdminActionContext,
  entry: AdminActionEntry
): Promise<void> {
  await recordAdminActions(ctx, [entry]);
}

/**
 * Records several entries, e.g. one row per user in a bulk action. An empty
 * list records nothing and does not count as recording for a handler spec.
 */
export async function recordAdminActions(
  ctx: AdminActionContext,
  entries: readonly AdminActionEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  noteAdminAuditRecordCall();
  await writeAdminActions(ctx, entries);
}

function storedMetadata(entry: AdminActionEntry): Record<string, unknown> | null {
  if (entry.outcome === 'failure') return { ...entry.metadata, errorCode: entry.errorCode };
  return entry.metadata ?? null;
}

function eventAttribution(ctx: AdminActionContext): AdminActionEventAttribution {
  return {
    kiloUserId: ctx.user.id,
    email: ctx.user.google_user_email,
    adminTier: adminTierFor(ctx.user),
    authVia: ctx.authViaToken ? 'token' : 'session',
    tokenSource: ctx.tokenSource ?? null,
    // A caller that names its own path (a tRPC procedure, or a route handler
    // that sets one) wins over the best-effort route from the request headers.
    route: ctx.trpcPath ?? ctx.auditRoute ?? null,
    ip: ctx.ip ?? null,
  };
}

async function writeAdminActions(
  ctx: AdminActionContext,
  entries: readonly AdminActionEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const insertedIds: string[] = [];
  try {
    for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
      const rows = await db
        .insert(admin_action_audit_logs)
        .values(
          entries.slice(start, start + INSERT_CHUNK_SIZE).map(entry => ({
            action: entry.action,
            outcome: entry.outcome ?? 'success',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_type: entry.target?.type ?? null,
            target_id: entry.target?.id ?? null,
            message: entry.message,
            metadata: storedMetadata(entry),
          }))
        )
        .returning({ id: admin_action_audit_logs.id });
      insertedIds.push(...rows.map(row => row.id));
    }
  } catch (error) {
    captureException(error, {
      tags: { operation: 'admin_action_audit_insert' },
      extra: { actions: entries.map(entry => entry.action) },
    });
  }

  const attribution = eventAttribution(ctx);
  if (entries.length === 1) {
    emit(entryEvent(attribution, entries[0], insertedIds[0] ?? null));
    return;
  }

  for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
    const end = Math.min(start + INSERT_CHUNK_SIZE, entries.length);
    // Chunks are inserted in order and the first failed insert stops the rest,
    // so a chunk is stored exactly when its last entry has a row id.
    if (end > insertedIds.length) {
      for (let index = start; index < end; index++) {
        emit(entryEvent(attribution, entries[index], null));
      }
      continue;
    }
    const groups = new Map<string, number[]>();
    for (let index = start; index < end; index++) {
      const entry = entries[index];
      const key = `${entry.action}\u0000${entry.outcome ?? 'success'}`;
      const group = groups.get(key);
      if (group) group.push(index);
      else groups.set(key, [index]);
    }
    for (const indexes of groups.values()) {
      emit(bulkEvent(attribution, entries, insertedIds, indexes));
    }
  }
}

function entryEvent(
  attribution: AdminActionEventAttribution,
  entry: AdminActionEntry,
  auditLogId: string | null
): AdminActionEntryEvent {
  return {
    event: 'admin_action',
    action: entry.action,
    outcome: entry.outcome ?? 'success',
    auditLogId,
    persisted: auditLogId !== null,
    ...attribution,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    message: entry.message,
    metadata: storedMetadata(entry),
  };
}

function bulkEvent(
  attribution: AdminActionEventAttribution,
  entries: readonly AdminActionEntry[],
  insertedIds: readonly string[],
  indexes: readonly number[]
): AdminActionBulkEvent {
  const listed = indexes.map(index => entries[index]);
  const [first] = listed;
  function shared<T>(read: (entry: AdminActionEntry) => T): T | null {
    const value = read(first);
    const key = JSON.stringify(value);
    return listed.every(entry => JSON.stringify(read(entry)) === key) ? value : null;
  }
  return {
    event: 'admin_action',
    action: first.action,
    outcome: first.outcome ?? 'success',
    entryCount: listed.length,
    auditLogIds: indexes.map(index => insertedIds[index]),
    persisted: true,
    ...attribution,
    targetType: shared(entry => entry.target?.type ?? null),
    targetIds: listed.map(entry => entry.target?.id ?? null),
    errorCodes:
      first.outcome === 'failure'
        ? listed.flatMap(entry => (entry.outcome === 'failure' ? [entry.errorCode] : []))
        : null,
    message: shared(entry => entry.message),
    metadata: shared(storedMetadata),
  };
}

function emit(event: AdminActionEvent): void {
  try {
    currentSink(event);
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_action_log' } });
  }
}

export function userActionTarget(userId: string): AdminActionTarget {
  return { type: 'user', id: userId };
}

// A local part starts with a letter or a digit, so punctuation that precedes a
// pasted address in prose stays in the text: brackets, quotes, an ellipsis, a
// dash, a question or exclamation mark, and a slash. Everything after that first
// character is replaced, whatever it is, so no fragment of the local part
// survives.
const EMAIL_ADDRESS_PATTERN = /[\p{L}\p{N}][^\s@]*@[^\s@]+\.[\p{L}\p{M}]{2,}/gu;

/**
 * Replaces email addresses in operator-typed free text, such as the reason an
 * admin gives for a refund. Apply it at the boundary where operator text enters
 * and use the result for every record written from it: the audit table is
 * browsable by every platform admin, and the target user records hold block
 * reason, admin note and credit transaction description that admins read too.
 *
 * The domain match accepts Unicode letters and combining marks and requires a
 * dotted domain of at least two letters: an intranet host without a dot, and a
 * bracketed IP literal, are not treated as customer addresses and stay in the
 * text.
 */
export function redactEmailAddressesInAuditText(text: string): string {
  return text.replace(EMAIL_ADDRESS_PATTERN, '[redacted-email]');
}

export function organizationActionTarget(organizationId: string): AdminActionTarget {
  return { type: 'organization', id: organizationId };
}

/**
 * Records an organization write made through the `is_admin` escape hatch, i.e.
 * by a Kilo admin whose own membership in the organization would not have
 * allowed it. Admins acting within a role they actually hold are ordinary
 * members and are not recorded.
 *
 * `requiredRoles` and `membershipScope` must mirror the guard the admin
 * bypassed: some guards accept roles inherited from a parent organization,
 * others only a direct membership. Pass `heldRoles` when the action itself
 * changes the actor's membership (e.g. self-removal) and the roles were read
 * beforehand.
 *
 * Reads stay as `kilo_admin_elevation` log lines; call this only from
 * mutations, after they succeed. Like {@link recordAdminAction} it never
 * throws: if the membership lookup fails, the action is recorded with
 * `heldRoles: null` rather than failing a request that already took effect.
 */
export async function recordElevatedOrganizationAdminAction(
  ctx: AdminActionContext & { user: { is_admin: boolean } },
  params: {
    organizationId: string;
    requiredRoles: readonly OrganizationRole[];
    membershipScope?: OrganizationMembershipScope;
    heldRoles?: OrganizationRole[];
    action: AdminActionAuditAction;
    message: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  // Counts as the audit of an enclosing scope even when nothing is written: an
  // admin acting within a role they hold is an ordinary member.
  noteAdminAuditRecordCall();
  if (!ctx.user.is_admin) return;

  let heldRoles: OrganizationRole[] | null = params.heldRoles ?? null;
  if (heldRoles === null) {
    try {
      heldRoles = await getOrganizationMembershipRoles(
        ctx.user.id,
        params.organizationId,
        params.membershipScope ?? 'direct_or_inherited'
      );
    } catch (error) {
      captureException(error, { tags: { operation: 'admin_action_membership_lookup' } });
    }
  }
  if (heldRoles?.some(role => params.requiredRoles.includes(role))) return;

  await writeAdminActions(ctx, [
    {
      action: params.action,
      target: organizationActionTarget(params.organizationId),
      message: params.message,
      metadata: { ...params.metadata, heldRoles },
    },
  ]);
}

export type OrganizationMembershipScope = 'direct' | 'direct_or_inherited';

/**
 * The caller's real roles in an organization: direct memberships, plus roles
 * inherited from a parent organization when `scope` allows, mirroring
 * ensureOrganizationAccess for non-admins.
 */
export async function getOrganizationMembershipRoles(
  userId: string,
  organizationId: string,
  scope: OrganizationMembershipScope
): Promise<OrganizationRole[]> {
  const direct = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId)
      )
    );
  const inherited =
    scope === 'direct'
      ? []
      : await db
          .select({ role: organization_memberships.role })
          .from(organizations)
          .innerJoin(
            organization_memberships,
            and(
              eq(organization_memberships.organization_id, organizations.parent_organization_id),
              eq(organization_memberships.kilo_user_id, userId),
              inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
            )
          )
          .where(eq(organizations.id, organizationId));
  return [...new Set([...direct, ...inherited].map(row => row.role))];
}

/** Audit context for REST route handlers, which have request headers instead of a tRPC context. */
export function adminActionContextFromHeaders(
  user: AdminActionContext['user'] & { is_admin: boolean },
  headersList: Headers
): AdminActionContext & { user: { is_admin: boolean } } {
  return {
    user,
    authViaToken: authViaTokenFromHeaders(headersList),
    tokenSource: null,
    ip: clientIpFromHeaders(headersList),
    auditRoute: routeFromHeaders(headersList) ?? undefined,
  };
}

/**
 * How one admin write is audited, declared next to it: on a tRPC mutation as
 * `.meta({ adminAudit })`, on a REST write handler through
 * {@link auditedAdminRoute}.
 *
 * - `declarative`: the scope records the success row itself. Its target is the
 *   one the handler set with {@link setAdminAuditTarget}, else `target(input)`,
 *   where `input` is the raw tRPC input or the awaited REST route params. Do
 *   not also record the same action in the handler.
 * - `handler`: the handler records its own rows with {@link recordAdminAction},
 *   {@link recordAdminActions} or {@link recordElevatedOrganizationAdminAction}.
 *   A call that succeeds without one is reported (and throws in tests).
 * - `exempt`: nothing is recorded. Only for mutation-typed reads and
 *   development-only operators; `reason` says which.
 *
 * Either recording kind gets one failure row, with a stable `errorCode`, when
 * the call throws or fails. Its action is the declarative action, else the one
 * the handler named with {@link setAdminAuditFailureAction}, else the first
 * handler action. A call whose input never parsed records that row with no
 * target, since its input names nothing that was validated.
 */
export type AdminAuditSpec =
  | {
      kind: 'declarative';
      action: AdminActionAuditAction;
      target?: (input: unknown) => AdminActionTarget | null;
    }
  | {
      kind: 'handler';
      actions: readonly [AdminActionAuditAction, ...AdminActionAuditAction[]];
    }
  | { kind: 'exempt'; reason: string };

/** Declarative target read from one string field of the call input. */
export function inputFieldTarget(
  type: AdminActionAuditTargetType,
  field: string
): (input: unknown) => AdminActionTarget | null {
  return input => {
    const id = targetIdFromInput(field, input);
    return id === null ? null : { type, id };
  };
}

export type AdminAuditActor = AdminActionContext['user'] & { is_admin: boolean };

type AdminAuditScopeState = {
  /** The actions the scope's spec declares; the first is the default failure action. */
  actions: readonly [AdminActionAuditAction, ...AdminActionAuditAction[]];
  target: { kind: 'unset' } | { kind: 'set'; target: AdminActionTarget | null };
  metadata: Record<string, unknown>;
  recordCalls: number;
  actor: AdminAuditActor | null;
  failureAction: AdminActionAuditAction | null;
};

const adminAuditScope = new AsyncLocalStorage<AdminAuditScopeState>();

/** Overrides the spec target for the rows the enclosing audit scope records. */
export function setAdminAuditTarget(target: AdminActionTarget | null): void {
  const state = adminAuditScope.getStore();
  if (state) state.target = { kind: 'set', target };
}

/**
 * Adds metadata to the rows the enclosing audit scope records. Safe ids and
 * counts only, as for any entry.
 */
export function addAdminAuditMetadata(metadata: Record<string, unknown>): void {
  const state = adminAuditScope.getStore();
  if (state) Object.assign(state.metadata, metadata);
}

/**
 * Names the action a failure of the enclosing audit scope records, for a
 * handler spec that declares several. It must be one of the spec's actions.
 */
export function setAdminAuditFailureAction(action: AdminActionAuditAction): void {
  const state = adminAuditScope.getStore();
  if (!state) return;
  if (!state.actions.includes(action)) {
    reportAdminAuditGap(`failure action ${action} is not declared by the audit spec`);
    return;
  }
  state.failureAction = action;
}

/**
 * Names the authenticated admin of a REST handler wrapped in
 * {@link auditedAdminRoute}; call it right after the admin check. A tRPC
 * scope takes the admin from its context instead.
 */
export function setAdminAuditActor(user: AdminAuditActor): void {
  const state = adminAuditScope.getStore();
  if (state) state.actor = user;
}

function noteAdminAuditRecordCall(): void {
  const state = adminAuditScope.getStore();
  if (state) state.recordCalls += 1;
}

export type AdminAuditOutcome =
  | { outcome: 'success' }
  | { outcome: 'failure'; errorCode: string; inputRejected?: boolean };

export type AdminAuditRun<TResult> = {
  spec: AdminAuditSpec;
  /** The tRPC path or REST pathname; the recorded rows' message names it. */
  route: string;
  /**
   * The audit context of the call's admin. `actor` is the admin a REST handler
   * named with {@link setAdminAuditActor}, null when it named none. Return
   * null when no admin is known: a failure then records nothing, since the
   * request never reached an admin action.
   */
  context: (actor: AdminAuditActor | null) => AdminActionContext | null;
  input: () => Promise<unknown>;
  run: () => Promise<TResult>;
  outcomeOf: (result: TResult) => AdminAuditOutcome;
};

/**
 * Runs one admin write inside an audit scope and records what its spec
 * declares. The result, or the thrown error, is passed through unchanged.
 */
export async function runAdminAuditScope<TResult>(
  params: AdminAuditRun<TResult>
): Promise<TResult> {
  const { spec } = params;
  if (spec.kind === 'exempt') return params.run();

  const state: AdminAuditScopeState = {
    actions: spec.kind === 'declarative' ? [spec.action] : spec.actions,
    target: { kind: 'unset' },
    metadata: {},
    recordCalls: 0,
    actor: null,
    failureAction: null,
  };
  let result: TResult;
  try {
    result = await adminAuditScope.run(state, params.run);
  } catch (error) {
    await recordScopeFailure(params, state, {
      outcome: 'failure',
      errorCode: adminAuditErrorCode(error),
      inputRejected: isAdminAuditInputRejection(error),
    });
    throw error;
  }

  const outcome = params.outcomeOf(result);
  if (outcome.outcome === 'failure') {
    await recordScopeFailure(params, state, outcome);
  } else if (spec.kind === 'declarative') {
    const ctx = params.context(state.actor);
    if (ctx === null) {
      reportAdminAuditGap(`${params.route} succeeded without naming its admin actor`);
    } else {
      await writeAdminActions(ctx, [
        {
          action: spec.action,
          target: await scopeTarget(params, state),
          message: params.route,
          metadata: scopeMetadata(state),
        },
      ]);
    }
  } else if (state.recordCalls === 0) {
    reportAdminAuditGap(`${params.route} succeeded without recording ${spec.actions.join(', ')}`);
  }
  return result;
}

async function recordScopeFailure<TResult>(
  params: AdminAuditRun<TResult>,
  state: AdminAuditScopeState,
  failure: Extract<AdminAuditOutcome, { outcome: 'failure' }>
): Promise<void> {
  const ctx = params.context(state.actor);
  if (ctx === null) return;
  await writeAdminActions(ctx, [
    {
      action: state.failureAction ?? state.actions[0],
      outcome: 'failure',
      errorCode: failure.errorCode,
      target: failure.inputRejected ? null : await scopeTarget(params, state),
      message: `${params.route} failed`,
      metadata: scopeMetadata(state),
    },
  ]);
}

async function scopeTarget<TResult>(
  params: AdminAuditRun<TResult>,
  state: AdminAuditScopeState
): Promise<AdminActionTarget | null> {
  if (state.target.kind === 'set') return state.target.target;
  if (params.spec.kind !== 'declarative' || params.spec.target === undefined) return null;
  try {
    return params.spec.target(await params.input());
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_action_audit_target' } });
    return null;
  }
}

function scopeMetadata(state: AdminAuditScopeState): Record<string, unknown> | undefined {
  return Object.keys(state.metadata).length > 0 ? { ...state.metadata } : undefined;
}

const MAX_ERROR_CODE_LENGTH = 64;

/**
 * A stable code for a thrown value: the `TRPCError` code, else the error's
 * `name` (its class, unless it set its own). Never the message, which can
 * carry user data or secrets.
 */
export function adminAuditErrorCode(error: unknown): string {
  if (error instanceof TRPCError) return error.code;
  if (error instanceof Error) return error.name.slice(0, MAX_ERROR_CODE_LENGTH) || 'Error';
  return typeof error;
}

/**
 * Whether a thrown value is tRPC's refusal of input that never parsed: a
 * `BAD_REQUEST` caused by the procedure's zod schema.
 */
export function isAdminAuditInputRejection(error: unknown): boolean {
  return (
    error instanceof TRPCError && error.code === 'BAD_REQUEST' && error.cause instanceof z.ZodError
  );
}

/**
 * Reports an admin write the audit could not attribute or did not see
 * recorded. Throws in tests so the gap fails the test that exercised it.
 */
export function reportAdminAuditGap(message: string): void {
  const error = new Error(`Admin audit gap: ${message}`);
  captureException(error, { tags: { operation: 'admin_action_audit_gap' } });
  if (process.env.NODE_ENV === 'test') throw error;
}

const AUDITED_ADMIN_ROUTE = Symbol.for('kilocode.auditedAdminRoute');

/**
 * Wraps an App Router admin write handler in an audit scope. A response
 * status below 400 is a success; 400 and above records a failure row whose
 * `errorCode` is the status; a throw records a failure row and is rethrown.
 * The handler must call {@link setAdminAuditActor} once it has authenticated
 * the admin; until then a failure records nothing.
 */
export function auditedAdminRoute<TArgs extends [Request, ...unknown[]]>(
  spec: AdminAuditSpec,
  handler: (...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  const wrapped = (...args: TArgs): Promise<Response> => {
    const [request, routeContext] = args;
    const route = new URL(request.url).pathname;
    return runAdminAuditScope({
      spec,
      route,
      context: actor =>
        actor === null
          ? null
          : { ...adminActionContextFromHeaders(actor, request.headers), auditRoute: route },
      input: () => routeParams(routeContext),
      run: () => handler(...args),
      outcomeOf: response =>
        response.status < 400
          ? { outcome: 'success' }
          : { outcome: 'failure', errorCode: String(response.status) },
    });
  };
  Object.defineProperty(wrapped, AUDITED_ADMIN_ROUTE, { value: spec, enumerable: false });
  return wrapped;
}

/** Whether a route module export was built with {@link auditedAdminRoute}. */
export function isAuditedAdminRoute(handler: unknown): boolean {
  return typeof handler === 'function' && AUDITED_ADMIN_ROUTE in handler;
}

async function routeParams(routeContext: unknown): Promise<unknown> {
  if (typeof routeContext !== 'object' || routeContext === null || !('params' in routeContext)) {
    return null;
  }
  return await routeContext.params;
}

const AdminAuditSpecShape = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('declarative'),
    action: AdminActionAuditAction,
    target: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('handler'), actions: z.array(AdminActionAuditAction).min(1) }),
  z.object({ kind: z.literal('exempt'), reason: z.string().trim().min(1) }),
]);

const AdminAuditMetaShape = z.object({ adminAudit: AdminAuditSpecShape });

export type DiscoveredProcedure = {
  _def?: { type?: string; middlewares?: readonly unknown[]; meta?: unknown };
};

/**
 * Paths of the admin-guarded mutations among `procedures` (a router's
 * `_def.procedures`) whose meta declares no valid `adminAudit` spec.
 */
export function adminMutationsMissingAuditSpec(
  procedures: Record<string, DiscoveredProcedure>
): string[] {
  return Object.entries(procedures)
    .filter(
      ([, procedure]) =>
        procedure._def?.type === 'mutation' &&
        privilegedGuardTiers(procedure._def.middlewares ?? []).includes('admin') &&
        !AdminAuditMetaShape.safeParse(procedure._def.meta).success
    )
    .map(([path]) => path)
    .sort();
}
