import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  controlPlaneCredentialSourceSchema,
  controlPlaneFailureReasonSchema,
  controlPlaneRouteSpecSchema,
  type ControlPlaneCredentialSource,
  type ControlPlaneFailureReason,
  type ControlPlanePreparationStep,
  type ControlPlaneRouteSpec,
  type ControlPlaneRouteUpdate,
  type ControlPlaneRouteView,
  type ControlPlaneWorkspaceFailureSubtype,
} from '../../shared/control-plane-protocol.js';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import { routes as routesTable } from './sqlite-schema.js';
import { readScopeGrant, removeScopeMember, scopeGrantId } from './scope-grants.js';

export type RouteDatabase = ReturnType<typeof drizzle>;

export const ROUTE_STATES = ['preparing', 'ready', 'failed'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export type RouteGrant = SessionCredentialGrant;

/**
 * One session on one sandbox (spec §6 "Route state"). `state` is the single
 * state value; `attemptId`/`attemptDeadlineAt` belong to the current
 * preparation attempt and are replaced only when a new attempt starts.
 * `credentialSource` is the DO-only issue-time snapshot; it is never sent to
 * the wrapper.
 */
export type RouteRecord = {
  sessionId: string;
  spec: ControlPlaneRouteSpec;
  grant: RouteGrant | null;
  credentialSource: ControlPlaneCredentialSource | null;
  state: RouteState;
  attemptId: string;
  attemptDeadlineAt: number;
  reason: ControlPlaneFailureReason | null;
};

/** One preparation step and an optional live detail line within it. */
export type RoutePreparationProgress = {
  step: ControlPlanePreparationStep;
  detail?: string;
};

/** The grant outcome for a route attempt: a re-projected spec plus the grant. */
export type RouteGrantIssue = {
  spec: ControlPlaneRouteSpec;
  grant: RouteGrant;
};

/**
 * What the route transitions need from the DO: storage, the attempt length, the
 * bound wrapper socket, the bounded session notification, and grant issuance.
 * Keeping them here keeps this the one module that starts an attempt and moves
 * route state.
 */
export type RouteContext = {
  db: RouteDatabase;
  now: () => number;
  routePreparationMs: number;
  /** Sends `session.prepare` when a wrapper socket is bound; a no-op otherwise. */
  sendPrepare: (route: RouteRecord) => void;
  /** Short bounded notification to the session's V2 DO; dropped on failure. */
  notify: (sessionId: string, update: ControlPlaneRouteUpdate) => Promise<void>;
  /**
   * Mints the route grant and returns the wrapper-safe spec. Only called when a
   * credential source is present; a null source means the route has no grant.
   */
  issueGrant: (
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource
  ) => Promise<RouteGrantIssue>;
  /**
   * Applies the provider credential policy for the current grants. Resolves
   * `true` when applied (or not applicable) and `false` on failure; callers must
   * not send a credential-bearing frame when it returns `false`.
   */
  applyPolicy: (candidate?: RouteGrant) => Promise<boolean>;
  publishGrant: (route: RouteRecord) => void;
};

type RouteRow = typeof routesTable.$inferSelect;

function parseRouteState(value: string): RouteState {
  const found = ROUTE_STATES.find(state => state === value);
  if (found === undefined) throw new Error(`Unknown route state: ${value}`);
  return found;
}

export function routeFromRow(db: RouteDatabase, row: RouteRow): RouteRecord {
  return {
    sessionId: row.session_id,
    spec: controlPlaneRouteSpecSchema.parse(JSON.parse(row.spec)),
    grant: row.grant === null ? null : readScopeGrant(db, row.grant),
    credentialSource:
      row.credential_source === null || row.credential_source === undefined
        ? null
        : controlPlaneCredentialSourceSchema.parse(JSON.parse(row.credential_source)),
    state: parseRouteState(row.state),
    attemptId: row.attempt_id,
    attemptDeadlineAt: row.attempt_deadline_at ?? 0,
    reason: row.reason === null ? null : controlPlaneFailureReasonSchema.parse(row.reason),
  };
}

function routeToRow(route: RouteRecord): typeof routesTable.$inferInsert {
  return {
    session_id: route.sessionId,
    spec: JSON.stringify(route.spec),
    grant: route.grant === null ? null : scopeGrantId(route.grant),
    credential_source:
      route.credentialSource === null ? null : JSON.stringify(route.credentialSource),
    state: route.state,
    attempt_id: route.attemptId,
    attempt_deadline_at: route.attemptDeadlineAt,
    reason: route.reason,
    updated_at: Date.now(),
  };
}

export function newPreparingRoute(
  spec: ControlPlaneRouteSpec,
  attemptId: string,
  attemptDeadlineAt: number,
  grant: RouteGrant | null,
  credentialSource: ControlPlaneCredentialSource | null
): RouteRecord {
  return {
    sessionId: spec.sessionId,
    spec,
    grant,
    credentialSource,
    state: 'preparing',
    attemptId,
    attemptDeadlineAt,
    reason: null,
  };
}

/**
 * The view the Sandbox DO notifies and `prepare` returns (spec §6). It is the
 * route state, except that a `ready` route with no live socket is
 * `reconnecting` and a missing route is `unknown`. A preparing route carries
 * the sandbox step when the allocation, not the wrapper, is the one progressing.
 */
export function routeView(
  route: RouteRecord | null,
  connected: boolean,
  sandboxProgress?: RoutePreparationProgress
): ControlPlaneRouteView {
  if (route === null) return { state: 'unknown' };
  if (route.state === 'ready') {
    return connected
      ? { state: 'ready', attemptId: route.attemptId }
      : { state: 'reconnecting', attemptId: route.attemptId };
  }
  if (route.state === 'failed') {
    return {
      state: 'failed',
      attemptId: route.attemptId,
      reason: route.reason ?? 'preparation_timeout',
    };
  }
  return { state: 'preparing', attemptId: route.attemptId, ...sandboxProgress };
}

// --- storage -----------------------------------------------------------------

export async function readRoute(db: RouteDatabase, sessionId: string): Promise<RouteRecord | null> {
  const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
  const row = rows[0];
  return row === undefined ? null : routeFromRow(db, row);
}

export async function listRoutes(db: RouteDatabase): Promise<RouteRecord[]> {
  const rows = await db.select().from(routesTable);
  return rows.map(row => routeFromRow(db, row));
}

export function writeRoute(db: Pick<RouteDatabase, 'insert'>, route: RouteRecord): void {
  const row = routeToRow(route);
  db.insert(routesTable)
    .values(row)
    .onConflictDoUpdate({ target: routesTable.session_id, set: row })
    .run();
}

export async function deleteRoute(db: RouteDatabase, sessionId: string): Promise<void> {
  db.transaction(tx => {
    removeScopeMember(tx, sessionId);
    tx.delete(routesTable).where(eq(routesTable.session_id, sessionId)).run();
  });
}

/** Latest attempt deadline among preparing routes, or null when there is none. */
export async function pendingRouteDeadlineAt(db: RouteDatabase): Promise<number | null> {
  const rows = await db
    .select({ at: routesTable.attempt_deadline_at })
    .from(routesTable)
    .where(eq(routesTable.state, 'preparing'));
  const values = rows
    .map(row => row.at)
    .filter((value): value is number => typeof value === 'number');
  return values.length === 0 ? null : Math.max(...values);
}

/** Earliest attempt deadline among preparing routes, or null when there is none. */
export async function earliestRouteDeadlineAt(db: RouteDatabase): Promise<number | null> {
  const rows = await db
    .select({ at: routesTable.attempt_deadline_at })
    .from(routesTable)
    .where(eq(routesTable.state, 'preparing'));
  const values = rows
    .map(row => row.at)
    .filter((value): value is number => typeof value === 'number');
  return values.length === 0 ? null : Math.min(...values);
}

// --- route transitions -------------------------------------------------------

/**
 * A route spec with no issuer material, used only when issuance fails. It is
 * never sent to a wrapper (the route is `failed`), and it keeps native tokens
 * and env out of the routes table.
 */
function redactRouteSpec(spec: ControlPlaneRouteSpec): ControlPlaneRouteSpec {
  return {
    sessionId: spec.sessionId,
    kiloSessionId: spec.kiloSessionId,
    directory: spec.directory,
    ...(spec.branch === undefined ? {} : { branch: spec.branch }),
    ...(spec.branchMode === undefined ? {} : { branchMode: spec.branchMode }),
    ...(spec.setupCommands === undefined ? {} : { setupCommands: spec.setupCommands }),
    ...(spec.runtimeIsolation === undefined ? {} : { runtimeIsolation: spec.runtimeIsolation }),
    attemptId: spec.attemptId,
  };
}

export async function failRoute(
  ctx: RouteContext,
  spec: ControlPlaneRouteSpec,
  attemptId: string,
  reason: ControlPlaneFailureReason,
  stage = 'route'
): Promise<RouteRecord> {
  const existing = await readRoute(ctx.db, spec.sessionId);
  const route: RouteRecord = {
    sessionId: spec.sessionId,
    spec: redactRouteSpec(spec),
    grant: existing?.grant ?? null,
    credentialSource: existing?.credentialSource ?? null,
    state: 'failed',
    attemptId,
    attemptDeadlineAt: 0,
    reason,
  };
  writeRoute(ctx.db, route);
  logControlDiagnostic('route_failed', {
    sessionId: spec.sessionId,
    attemptId,
    reason,
    stage,
  });
  await ctx.notify(spec.sessionId, { state: 'failed', attemptId, reason });
  return route;
}

/**
 * Whether `route` is still the fenced preparation attempt a late async task
 * belongs to. Shared so every late-mint/route-failure path fences identically.
 */
export function isCurrentPreparingAttempt(
  route: RouteRecord | null,
  attemptId: string
): route is RouteRecord {
  return route !== null && route.state === 'preparing' && route.attemptId === attemptId;
}

/**
 * Fails one specific preparation attempt, fenced by its attempt id. Used by the
 * R1 runtime credential proxy mint: a mint/bind failure that settles after the
 * attempt moved on must not fail a newer attempt.
 */
export async function failCurrentAttempt(
  ctx: RouteContext,
  sessionId: string,
  attemptId: string,
  reason: ControlPlaneFailureReason,
  stage = 'attempt'
): Promise<void> {
  const route = await readRoute(ctx.db, sessionId);
  if (!isCurrentPreparingAttempt(route, attemptId)) return;
  await failRoute(ctx, route.spec, attemptId, reason, stage);
}

/**
 * Bounded in-attempt retries for a transient credential-policy failure. Only the
 * Vercel network-policy refresh is retried, and each call is bounded at ~30 s
 * inside the Sandbox DO serial queue, so the budget is one retry (two attempts).
 * Grant issuance is not retried — its validation errors are permanent and a hung
 * issuer must fail fast rather than hold the queue.
 */
const ATTEMPT_POLICY_ATTEMPTS = 2;

/**
 * Starts and persists a new preparation attempt: the one place an attempt is
 * created (spec §6). The stored spec carries the attempt id the wrapper sees.
 * When a credential source is present the DO mints a fresh grant and the stored
 * spec is the wrapper-safe projection of it. Issuance failure fails the route
 * closed at once (permanent validation errors and hung issuers must not be
 * retried); a transient policy failure is retried in-attempt. Either way the
 * failure does not throw, so a sibling route still gets its attempt.
 */
export async function startAttempt(
  ctx: RouteContext,
  spec: ControlPlaneRouteSpec,
  source: ControlPlaneCredentialSource | null
): Promise<RouteRecord> {
  const attemptId = crypto.randomUUID();
  const attemptSpec: ControlPlaneRouteSpec = { ...spec, attemptId };
  logControlDiagnostic('route_attempt', {
    sessionId: spec.sessionId,
    attemptId,
    credentialSource: source !== null,
  });
  if (source === null) {
    return failRoute(
      ctx,
      attemptSpec,
      attemptId,
      'workspace_setup_failed',
      'credential_source_missing'
    );
  }
  let issued: RouteGrantIssue;
  try {
    issued = await ctx.issueGrant(attemptSpec, source);
  } catch {
    return failRoute(
      ctx,
      attemptSpec,
      attemptId,
      'workspace_setup_failed',
      'credential_grant_failed'
    );
  }
  const route = newPreparingRoute(
    issued.spec,
    attemptId,
    ctx.now() + ctx.routePreparationMs,
    issued.grant,
    source
  );
  for (let attempt = 1; attempt <= ATTEMPT_POLICY_ATTEMPTS; attempt += 1) {
    if (await ctx.applyPolicy(issued.grant)) {
      ctx.publishGrant(route);
      ctx.sendPrepare(route);
      return route;
    }
  }
  return failRoute(
    ctx,
    attemptSpec,
    attemptId,
    'workspace_setup_failed',
    'credential_policy_unavailable'
  );
}

/**
 * The `prepare` route effect. Starts an attempt when the route is absent or
 * `failed`; any other route keeps its attempt deadline. `started` tells the
 * caller whether it must re-arm for the new deadline.
 */
export async function ensureRoute(
  ctx: RouteContext,
  spec: ControlPlaneRouteSpec,
  source: ControlPlaneCredentialSource | null
): Promise<{ route: RouteRecord; started: boolean }> {
  const existing = await readRoute(ctx.db, spec.sessionId);
  if (existing !== null && existing.state !== 'failed') {
    return { route: existing, started: false };
  }
  return { route: await startAttempt(ctx, spec, source), started: true };
}

/** Ready routes after `hello`: a restart starts a new attempt, else re-notify. */
export async function onWrapperConnected(ctx: RouteContext, restarted: boolean): Promise<void> {
  for (const route of await listRoutes(ctx.db)) {
    if (route.state === 'ready' && restarted) {
      // Kilo state died with the old wrapper (spec §6): a new attempt.
      await ctx.notify(route.sessionId, {
        state: 'lost',
        attemptId: route.attemptId,
        reason: 'agent_restarted',
      });
      await startAttempt(ctx, route.spec, route.credentialSource);
      continue;
    }
    if (route.state === 'ready') {
      await ctx.notify(route.sessionId, { state: 'ready', attemptId: route.attemptId });
      continue;
    }
    if (route.state === 'preparing') {
      // Policy first: the wrapper must not receive aliases the firewall rejects.
      if (!(await ctx.applyPolicy())) {
        await onRouteFailed(ctx, route.sessionId, 'workspace_setup_failed', undefined, true);
        continue;
      }
      ctx.sendPrepare(route);
    }
  }
}

/** Notify every ready route that its wrapper socket is reconnecting. */
export async function notifyReadyRoutes(ctx: RouteContext): Promise<void> {
  for (const route of await listRoutes(ctx.db)) {
    if (route.state === 'ready') {
      await ctx.notify(route.sessionId, {
        state: 'reconnecting',
        attemptId: route.attemptId,
      });
    }
  }
}

/** Stop the sandbox: every ready route loses its session and is removed. */
export async function dropReadyRoutes(
  ctx: RouteContext,
  reason: ControlPlaneFailureReason
): Promise<void> {
  for (const route of await listRoutes(ctx.db)) {
    if (route.state !== 'ready') continue;
    await deleteRoute(ctx.db, route.sessionId);
    await ctx.notify(route.sessionId, { state: 'lost', attemptId: route.attemptId, reason });
  }
}

/** Fail preparing routes whose 12-minute attempt deadline has passed. */
export async function failExpiredRoutes(ctx: RouteContext): Promise<void> {
  const now = ctx.now();
  for (const route of await listRoutes(ctx.db)) {
    if (route.state !== 'preparing' || route.attemptDeadlineAt > now) continue;
    writeRoute(ctx.db, { ...route, state: 'failed', reason: 'preparation_timeout' });
    logControlDiagnostic('route_failed', {
      sessionId: route.sessionId,
      attemptId: route.attemptId,
      reason: 'preparation_timeout',
      stage: 'attempt_deadline',
      deadlineAt: route.attemptDeadlineAt,
      now,
    });
    await ctx.notify(route.sessionId, {
      state: 'failed',
      attemptId: route.attemptId,
      reason: 'preparation_timeout',
    });
  }
}

/** Whether any preparing route still has attempt time, so a create may retry. */
export async function routeRetryAllowed(ctx: RouteContext): Promise<boolean> {
  const deadline = await pendingRouteDeadlineAt(ctx.db);
  return deadline !== null && deadline > ctx.now();
}

export async function onRouteProgress(
  ctx: RouteContext,
  sessionId: string,
  progress: RoutePreparationProgress,
  current: boolean
): Promise<void> {
  if (!current) return;
  const route = await readRoute(ctx.db, sessionId);
  if (route === null || route.state !== 'preparing') return;
  logControlDiagnostic('route_progress', {
    sessionId,
    attemptId: route.attemptId,
    step: progress.step,
  });
  await ctx.notify(sessionId, { state: 'preparing', attemptId: route.attemptId, ...progress });
}

/** Sandbox allocation progress (create, start) for every preparing route. */
export async function notifyPreparingRoutes(
  ctx: RouteContext,
  progress: RoutePreparationProgress
): Promise<void> {
  for (const route of await listRoutes(ctx.db)) {
    if (route.state !== 'preparing') continue;
    await ctx.notify(route.sessionId, {
      state: 'preparing',
      attemptId: route.attemptId,
      ...progress,
    });
  }
}

export async function onRouteReady(
  ctx: RouteContext,
  sessionId: string,
  current: boolean
): Promise<void> {
  if (!current) return;
  const route = await readRoute(ctx.db, sessionId);
  if (route === null || route.state === 'failed') return;
  writeRoute(ctx.db, { ...route, state: 'ready', reason: null });
  logControlDiagnostic('route_ready', { sessionId, attemptId: route.attemptId });
  await ctx.notify(sessionId, { state: 'ready', attemptId: route.attemptId });
}

export async function onRouteFailed(
  ctx: RouteContext,
  sessionId: string,
  reason: ControlPlaneFailureReason,
  subtype: ControlPlaneWorkspaceFailureSubtype | undefined,
  current: boolean
): Promise<void> {
  if (!current) return;
  const route = await readRoute(ctx.db, sessionId);
  if (route === null || route.state === 'failed') return;
  writeRoute(ctx.db, { ...route, state: 'failed', reason });
  logControlDiagnostic('route_failed', {
    sessionId,
    attemptId: route.attemptId,
    reason,
    stage: 'wrapper_reported',
    subtype,
  });
  await ctx.notify(sessionId, {
    state: 'failed',
    attemptId: route.attemptId,
    reason,
    ...(subtype === undefined ? {} : { subtype }),
  });
}
