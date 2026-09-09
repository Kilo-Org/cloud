import type { SessionId } from './types.js';

export type SessionPlane = 'legacy' | 'control';

export type ControlPlaneOwnerEnv = {
  CONTROL_PLANE_IDS?: string;
};

export function sessionPlaneFromId(sessionId: string): SessionPlane {
  return sessionId.startsWith('workspace_') ? 'control' : 'legacy';
}

export function sessionSupportsTerminal(sessionId: string): boolean {
  const plane = sessionPlaneFromId(sessionId);
  return plane === 'legacy' || plane === 'control';
}

export function generateSessionId(plane: SessionPlane = 'legacy'): SessionId {
  const id = crypto.randomUUID();
  return plane === 'control' ? `workspace_${id}` : `agent_${id}`;
}

export type SessionCreateOrigin = {
  createdOnPlatform?: string;
};

export function isInteractiveWebSession(origin?: SessionCreateOrigin): boolean {
  return origin?.createdOnPlatform === 'cloud-agent-web';
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
