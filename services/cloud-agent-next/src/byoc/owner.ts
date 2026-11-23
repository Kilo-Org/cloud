import { z } from 'zod';

export const byocOwnerSchema = z.union([
  z.object({ organizationId: z.uuid(), userId: z.never().optional() }),
  z.object({ organizationId: z.never().optional(), userId: z.string().min(1) }),
]);
export type ByocOwner = z.infer<typeof byocOwnerSchema>;
export type ByocSource = ByocOwner & { credentialId: string };

export function byocOwnerFields(owner: ByocOwner): ByocOwner {
  return owner.organizationId !== undefined
    ? { organizationId: owner.organizationId }
    : { userId: owner.userId };
}

export function byocOwnerKey(owner: ByocOwner): string {
  return owner.organizationId ?? `user:${owner.userId}`;
}

export function enrolledByocOwner(
  ids: string | undefined,
  owner: { userId?: string; orgId?: string }
): ByocOwner | undefined {
  const id = owner.orgId ?? owner.userId;
  if (!id) return undefined;
  const entries = (ids ?? '').split(',').map(value => value.trim());
  if (!entries.includes('*') && !entries.includes(id)) return undefined;
  return owner.orgId !== undefined ? { organizationId: owner.orgId } : { userId: id };
}
