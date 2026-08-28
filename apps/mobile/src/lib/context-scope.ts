import { z } from 'zod';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { encodeStorageKey, SELECTED_CONTEXT_KEY_PREFIX } from '@/lib/storage-keys';

export const contextScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal') }),
  z.strictObject({ kind: z.literal('organization'), organizationId: z.string().min(1) }),
]);
export type ContextScope = Readonly<z.infer<typeof contextScopeSchema>>;
export type AuthenticatedOwner = Readonly<{
  authEpoch: number;
  generation: number;
  userId: string | null;
}>;

let owner: AuthenticatedOwner = Object.freeze({
  authEpoch: currentAuthEpoch(),
  generation: 0,
  userId: null,
});
const listeners = new Set<() => void>();

export function getAuthenticatedOwner(): AuthenticatedOwner {
  return owner;
}

/** Capture a persistence generation, including cleanup while sign-out has closed admission. */
export function captureAccountGeneration(): () => boolean {
  const epoch = currentAuthEpoch();
  const generation = owner.generation;
  return () => isCurrentAuthEpoch(epoch) && owner.generation === generation;
}

export function subscribeAuthenticatedOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: AuthenticatedOwner): AuthenticatedOwner {
  owner = Object.freeze(next);
  for (const listener of listeners) {
    listener();
  }
  return owner;
}

/** Revoke authority before changing credentials or any account-bound memory. Refresh does not call this. */
export function beginAuthenticatedOwner(): AuthenticatedOwner {
  return publish({ authEpoch: currentAuthEpoch(), generation: owner.generation + 1, userId: null });
}

export function isCurrentOwner(captured: AuthenticatedOwner): boolean {
  return (
    !isSignOutActive() &&
    isCurrentAuthEpoch(captured.authEpoch) &&
    captured.authEpoch === owner.authEpoch &&
    captured.generation === owner.generation &&
    (captured.userId === null || captured.userId === owner.userId)
  );
}

/** Only a getMe response requested in this credential generation can supply durable identity. */
export function confirmAuthenticatedOwner(captured: AuthenticatedOwner, userId: string): boolean {
  if (!userId || !isCurrentOwner(captured) || (owner.userId !== null && owner.userId !== userId)) {
    return false;
  }
  if (owner.userId === null) {
    publish({ ...owner, userId });
  }
  return true;
}

export function isAuthenticatedOwner(captured: AuthenticatedOwner): boolean {
  return captured.userId !== null && isCurrentOwner(captured);
}

export function contextScope(organizationId: string | null): ContextScope {
  return organizationId === null ? { kind: 'personal' } : { kind: 'organization', organizationId };
}

export function sameContext(left: ContextScope, right: ContextScope): boolean {
  return left.kind === 'personal'
    ? right.kind === 'personal'
    : right.kind === 'organization' && left.organizationId === right.organizationId;
}

const permissionFailureSchema = z.object({
  data: z.object({ code: z.enum(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED']) }),
});
export function isContextUnavailableError(error: unknown): boolean {
  return permissionFailureSchema.safeParse(error).success;
}

const selectedContextSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1),
  context: contextScopeSchema,
});
export type SelectedContextResult =
  | Readonly<{ status: 'present'; context: ContextScope }>
  | Readonly<{ status: 'absent' | 'malformed' | 'owner-mismatch' }>;

export function selectedContextStorageKey(userId: string): string {
  return encodeStorageKey(SELECTED_CONTEXT_KEY_PREFIX, userId);
}

export function serializeSelectedContext(userId: string, context: ContextScope): string {
  return JSON.stringify(selectedContextSchema.parse({ version: 1, userId, context }));
}

export function parseSelectedContext(bytes: string | null, userId: string): SelectedContextResult {
  if (bytes === null) {
    return { status: 'absent' };
  }
  try {
    const record = selectedContextSchema.safeParse(JSON.parse(bytes));
    if (!record.success) {
      return { status: 'malformed' };
    }
    return record.data.userId === userId
      ? { status: 'present', context: record.data.context }
      : { status: 'owner-mismatch' };
  } catch {
    return { status: 'malformed' };
  }
}
