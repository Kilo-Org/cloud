import type { SessionId } from './types.js';

export type SessionPlane = 'legacy' | 'control';

export const CONTROL_PLANE_SESSION_PREFIX = 'workspace_';

export type ControlPlaneOwnerEnv = {
  CONTROL_PLANE_IDS?: string;
};

export function sessionPlaneFromId(sessionId: string): SessionPlane {
  return sessionId.startsWith(CONTROL_PLANE_SESSION_PREFIX) ? 'control' : 'legacy';
}

export function sessionSupportsTerminal(sessionId: string): boolean {
  const plane = sessionPlaneFromId(sessionId);
  return plane === 'legacy' || plane === 'control';
}

export function generateSessionId(plane: SessionPlane = 'legacy'): SessionId {
  const id = crypto.randomUUID();
  return plane === 'control' ? `${CONTROL_PLANE_SESSION_PREFIX}${id}` : `agent_${id}`;
}

export type SessionCreateOrigin = {
  createdOnPlatform?: string;
};

export type SessionOwner = { userId: string; orgId?: string };

export const CODE_REVIEW_CONTROL_PLANE_ORG_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

export function isInteractiveWebSession(origin?: SessionCreateOrigin): boolean {
  return origin?.createdOnPlatform === 'cloud-agent-web';
}

export function isCodeReviewControlPlaneOwner(owner: SessionOwner): boolean {
  return owner.orgId === CODE_REVIEW_CONTROL_PLANE_ORG_ID;
}

export function isControlPlaneOwner(env: ControlPlaneOwnerEnv, owner: SessionOwner): boolean {
  return (
    ownerIdInList(env.CONTROL_PLANE_IDS, owner.userId) ||
    ownerIdInList(env.CONTROL_PLANE_IDS, owner.orgId)
  );
}

export function isWorktreeOwner(
  env: { WORKTREE_CREATION_ENABLED_IDS?: string },
  owner: SessionOwner
): boolean {
  return (
    ownerIdInList(env.WORKTREE_CREATION_ENABLED_IDS, owner.userId) ||
    ownerIdInList(env.WORKTREE_CREATION_ENABLED_IDS, owner.orgId)
  );
}

export function sessionPlaneForNewOwner(
  env: ControlPlaneOwnerEnv,
  owner: SessionOwner,
  origin?: SessionCreateOrigin
): SessionPlane {
  if (origin?.createdOnPlatform === 'code-review') {
    return isCodeReviewControlPlaneOwner(owner) ? 'control' : 'legacy';
  }
  return isControlPlaneOwner(env, owner) && isInteractiveWebSession(origin) ? 'control' : 'legacy';
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
