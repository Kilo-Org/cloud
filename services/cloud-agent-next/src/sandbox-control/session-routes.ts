export type SessionActivityState = 'idle' | 'active' | 'finalizing';

export type SessionRoute = {
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  worktreeId?: string;
  ownerId: string;
  lastState: SessionActivityState | null;
  lastStateAt: number | null;
  idleForMs: number | null;
  waitingOn: 'model' | 'tool' | 'finalizing' | 'preparation' | 'input' | null;
};

export type AttachRouteInput = {
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  worktreeId?: string;
  ownerId: string;
};

export type SessionStateReport = {
  state: SessionActivityState;
  idleForMs: number;
  waitingOn?: NonNullable<SessionRoute['waitingOn']>;
};

export type SessionEventIdentity = {
  directory: string;
  kiloSessionId?: string;
  rootKiloSessionId?: string;
};

export function emptyRouteTable(): Map<string, SessionRoute> {
  return new Map();
}

export function attachRoute(
  table: Map<string, SessionRoute>,
  input: AttachRouteInput,
  sandboxOwnerId: string
): { table: Map<string, SessionRoute>; route: SessionRoute; changed: boolean } {
  if (input.ownerId !== sandboxOwnerId) {
    throw new Error('Sandbox owner mismatch');
  }

  const existing = table.get(input.sessionId);
  if (existing) {
    if (
      existing.directory === input.directory &&
      existing.kiloSessionId === input.kiloSessionId &&
      existing.worktreeId === input.worktreeId &&
      existing.ownerId === input.ownerId
    ) {
      return { table, route: existing, changed: false };
    }
    throw new Error('Session route conflict');
  }

  for (const route of table.values()) {
    const sameWorktree = Boolean(input.worktreeId) && route.worktreeId === input.worktreeId;
    if (route.directory === input.directory && (!sameWorktree || route.ownerId !== input.ownerId)) {
      throw new Error('Directory already attached');
    }
    if (sameWorktree && route.directory !== input.directory) {
      throw new Error('Worktree already attached to another directory');
    }
    if (route.kiloSessionId === input.kiloSessionId) {
      throw new Error('Kilo session already attached');
    }
  }

  const route: SessionRoute = {
    sessionId: input.sessionId,
    kiloSessionId: input.kiloSessionId,
    directory: input.directory,
    ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
    ownerId: input.ownerId,
    lastState: null,
    lastStateAt: null,
    idleForMs: null,
    waitingOn: null,
  };
  table.set(input.sessionId, route);
  return { table, route, changed: true };
}

export function detachRoute(
  table: Map<string, SessionRoute>,
  sessionId: string
): { table: Map<string, SessionRoute>; existed: boolean } {
  const existed = table.delete(sessionId);
  return { table, existed };
}

export function getRouteBySessionId(
  table: Map<string, SessionRoute>,
  sessionId: string
): SessionRoute | undefined {
  return table.get(sessionId);
}

export function getRouteByDirectory(
  table: Map<string, SessionRoute>,
  directory: string
): SessionRoute | undefined {
  let match: SessionRoute | undefined;
  for (const route of table.values()) {
    if (route.directory !== directory) continue;
    if (match) return undefined;
    match = route;
  }
  return match;
}

export function getRouteByKiloSessionId(
  table: Map<string, SessionRoute>,
  kiloSessionId: string
): SessionRoute | undefined {
  for (const route of table.values()) {
    if (route.kiloSessionId === kiloSessionId) return route;
  }
  return undefined;
}

export function resolveSessionEventRoute(
  table: Map<string, SessionRoute>,
  identity: SessionEventIdentity
): SessionRoute | null {
  const sessionRoute = identity.kiloSessionId
    ? getRouteByKiloSessionId(table, identity.kiloSessionId)
    : undefined;
  const rootRoute = identity.rootKiloSessionId
    ? getRouteByKiloSessionId(table, identity.rootKiloSessionId)
    : undefined;
  if (identity.rootKiloSessionId !== undefined && !rootRoute) return null;
  if (rootRoute && sessionRoute && rootRoute !== sessionRoute) return null;
  const exactRoute = rootRoute ?? sessionRoute;
  if (exactRoute) {
    for (const route of table.values()) {
      if (route.directory === identity.directory && route.directory !== exactRoute.directory) {
        return null;
      }
    }
    return exactRoute;
  }
  if (identity.kiloSessionId !== undefined) return null;
  return getRouteByDirectory(table, identity.directory) ?? null;
}

export function applyReportedSessionState(
  table: Map<string, SessionRoute>,
  kiloSessionId: string,
  report: SessionStateReport,
  receivedAt: number
): { table: Map<string, SessionRoute>; changed: boolean } {
  const route = getRouteByKiloSessionId(table, kiloSessionId);
  if (!route) return { table, changed: false };

  const waitingOn = report.waitingOn ?? null;
  const changed = route.lastState !== report.state || route.waitingOn !== waitingOn;
  route.lastState = report.state;
  route.lastStateAt = receivedAt;
  route.idleForMs = report.idleForMs;
  route.waitingOn = waitingOn;
  return { table, changed };
}

export function hasActiveWork(table: Map<string, SessionRoute>): boolean {
  for (const route of table.values()) {
    if (route.lastState === 'active' || route.lastState === 'finalizing') return true;
  }
  return false;
}
