import { enrolledByocOwner, type ByocOwner } from './owner.js';
export {
  byocOwnerSchema as byocVercelOwnerSchema,
  byocOwnerFields as byocVercelOwnerFields,
  type ByocOwner as ByocVercelOwner,
} from './owner.js';

export const VERCEL_BYOC_REQUIRED_MESSAGE =
  'Kilo-paid Vercel compute is retired. Configure Vercel BYOC and start a new session.';

export function enrolledByocVercelOwner(
  env: { BYOC_VERCEL_IDS?: string },
  owner: { userId?: string; orgId?: string }
): ByocOwner | undefined {
  return enrolledByocOwner(env.BYOC_VERCEL_IDS, owner);
}
