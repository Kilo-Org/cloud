import type { PermissionAction } from './types';

const STRICTNESS: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

export function stricter(a: PermissionAction, b: PermissionAction): PermissionAction {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}
