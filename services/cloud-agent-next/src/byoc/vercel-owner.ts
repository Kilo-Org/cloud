import { z } from 'zod';

export const VERCEL_BYOC_REQUIRED_MESSAGE =
  'Kilo-paid Vercel compute is retired. Configure Vercel BYOC and start a new session.';

export const byocVercelOwnerSchema = z.union([
  z.object({ organizationId: z.uuid(), userId: z.never().optional() }),
  z.object({ organizationId: z.never().optional(), userId: z.string().min(1) }),
]);
export type ByocVercelOwner = z.infer<typeof byocVercelOwnerSchema>;

export function byocVercelOwnerFields(owner: ByocVercelOwner): ByocVercelOwner {
  return owner.organizationId !== undefined
    ? { organizationId: owner.organizationId }
    : { userId: owner.userId };
}

export function enrolledByocVercelOwner(
  env: { BYOC_VERCEL_IDS?: string },
  owner: { userId?: string; orgId?: string }
): ByocVercelOwner | undefined {
  const id = owner.orgId ?? owner.userId;
  if (id === undefined) return undefined;
  const enrolled = new Set(
    (env.BYOC_VERCEL_IDS ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
  if (!enrolled.has('*') && !enrolled.has(id)) return undefined;
  return owner.orgId !== undefined ? { organizationId: owner.orgId } : { userId: id };
}
