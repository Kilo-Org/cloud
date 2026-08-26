import type { SessionId } from './types.js';

export type SessionPlane = 'legacy' | 'control';

export type ControlPlaneOwnerEnv = {
  CONTROL_PLANE_IDS?: string;
};

export function sessionPlaneFromId(sessionId: string): SessionPlane {
  return sessionId.startsWith('workspace_') ? 'control' : 'legacy';
}

export function sessionSupportsTerminal(sessionId: string): boolean {
  return sessionPlaneFromId(sessionId) !== 'control';
}

export function generateSessionId(plane: SessionPlane = 'legacy'): SessionId {
  const id = crypto.randomUUID();
  return plane === 'control' ? `workspace_${id}` : `agent_${id}`;
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

export function sessionPlaneForNewOwner(
  env: ControlPlaneOwnerEnv,
  owner: { userId: string; orgId?: string }
): SessionPlane {
  return isControlPlaneOwner(env, owner) ? 'control' : 'legacy';
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
