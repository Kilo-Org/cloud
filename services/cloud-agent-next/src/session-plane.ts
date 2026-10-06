import type { SessionId } from './types.js';

export type SessionPlane = 'legacy' | 'control';

export const CONTROL_PLANE_SESSION_PREFIX = 'workspace_';

/** `billingOrigin` value that identifies a Code Reviewer session. */
export const CODE_REVIEW_PLATFORM = 'code-review';

export type ControlPlaneOwnerEnv = {
  CONTROL_PLANE_IDS?: string;
  CODE_REVIEW_CONTROL_PLANE_IDS?: string;
};

export function sessionPlaneFromId(sessionId: string): SessionPlane {
  return sessionId.startsWith(CONTROL_PLANE_SESSION_PREFIX) ? 'control' : 'legacy';
}

/**
 * Thin boolean predicates over `sessionPlaneFromId`, which stays the single
 * plane implementation. Callers that only need "is this plane" read one of
 * these instead of comparing the plane string themselves.
 */
export function isLegacySession(sessionId: string): boolean {
  return sessionPlaneFromId(sessionId) === 'legacy';
}

export function isControlSession(sessionId: string): boolean {
  return sessionPlaneFromId(sessionId) === 'control';
}

/**
 * The one plane decision for request handling: a control (`workspace_*`)
 * session resolves through `control` (the V2 stub) and a legacy (`agent_*`)
 * session through `legacy` (the legacy stub). Callers pass a per-plane factory
 * so `withDORetry` builds a fresh stub for every attempt; handlers never test
 * the plane themselves. A pre-rewrite `workspace_*` session with no V2
 * registration is answered by its control stub with the normal not-found.
 */
export function sessionFor<TControl, TLegacy>(
  sessionId: string,
  control: () => TControl,
  legacy: () => TLegacy
): TControl | TLegacy {
  return sessionPlaneFromId(sessionId) === 'control' ? control() : legacy();
}

export function sessionSupportsTerminal(sessionId: string): boolean {
  const plane = sessionPlaneFromId(sessionId);
  return plane === 'legacy' || plane === 'control';
}

export function generateSessionId(plane: SessionPlane = 'legacy'): SessionId {
  const id = crypto.randomUUID();
  return plane === 'control' ? `${CONTROL_PLANE_SESSION_PREFIX}${id}` : `agent_${id}`;
}

/**
 * The one place a Session DO is named (spec §3): `ownerId:sessionId`. The Worker
 * stub and both V2 DOs must address the same instance through this function.
 */
export function sessionDoName(ownerId: string, sessionId: string): string {
  return `${ownerId}:${sessionId}`;
}

/**
 * Recover the bare `sessionId` from a Session DO name. Split on the *last*
 * colon because `ownerId` may itself contain colons (for example
 * `oauth/google:12345:agent_abc`).
 */
export function sessionIdFromDoName(name: string): string {
  const lastColon = name.lastIndexOf(':');
  return lastColon >= 0 ? name.slice(lastColon + 1) : name;
}

export type SessionCreateOrigin = {
  createdOnPlatform?: string;
  /**
   * Worker-owned effective origin. Unlike the client-supplied
   * `createdOnPlatform`, this cannot be forged by a public create endpoint, so
   * specialized routing decisions read it here.
   */
  billingOrigin?: string;
};

export function isInteractiveWebSession(origin?: SessionCreateOrigin): boolean {
  return origin?.createdOnPlatform === 'cloud-agent-web';
}

export function isCodeReviewSession(origin?: SessionCreateOrigin): boolean {
  return origin?.billingOrigin === CODE_REVIEW_PLATFORM;
}

export function isControlPlaneOwner(
  env: ControlPlaneOwnerEnv,
  owner: { userId: string; orgId?: string }
): boolean {
  return (
    ownerIdInList(env.CONTROL_PLANE_IDS, owner.userId) ||
    ownerIdInList(env.CONTROL_PLANE_IDS, owner.orgId)
  );
}

export function isCodeReviewControlPlaneOwner(
  env: ControlPlaneOwnerEnv,
  owner: { userId: string; orgId?: string }
): boolean {
  return (
    ownerIdInList(env.CODE_REVIEW_CONTROL_PLANE_IDS, owner.userId) ||
    ownerIdInList(env.CODE_REVIEW_CONTROL_PLANE_IDS, owner.orgId)
  );
}

export function isWorktreeOwner(
  env: { WORKTREE_CREATION_ENABLED_IDS?: string },
  owner: { userId: string; orgId?: string }
): boolean {
  return (
    ownerIdInList(env.WORKTREE_CREATION_ENABLED_IDS, owner.userId) ||
    ownerIdInList(env.WORKTREE_CREATION_ENABLED_IDS, owner.orgId)
  );
}

export function sessionPlaneForNewOwner(
  env: ControlPlaneOwnerEnv,
  owner: { userId: string; orgId?: string },
  origin?: SessionCreateOrigin
): SessionPlane {
  if (isInteractiveWebSession(origin)) {
    return isControlPlaneOwner(env, owner) ? 'control' : 'legacy';
  }
  if (isCodeReviewSession(origin)) {
    return isCodeReviewControlPlaneOwner(env, owner) ? 'control' : 'legacy';
  }
  return 'legacy';
}

function ownerIdInList(raw: string | undefined, id: string | undefined): boolean {
  if (!raw) return false;
  const items = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (items.includes('*')) return true;
  return id !== undefined && items.includes(id);
}
