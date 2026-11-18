import { z } from 'zod';

import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { readCacheScope } from '@/lib/persist/cache-scope';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

export const BRIEFING_DISMISSALS_KEY = 'agent-briefing-dismissals';
const dismissalsSchema = z.array(
  z.object({
    reportId: z.string(),
    organizationId: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    synced: z.boolean(),
  })
);
export type BriefingDismissal = z.infer<typeof dismissalsSchema>[number];
const storedDismissalsSchema = z
  .string()
  .transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid JSON' });
      return z.NEVER;
    }
  })
  .pipe(dismissalsSchema);

export async function readBriefingDismissals(
  userId: string,
  authEpoch: number
): Promise<BriefingDismissal[]> {
  if (!isCurrentAuthEpoch(authEpoch) || isSignOutActive()) {
    return [];
  }
  const scope = readCacheScope(userId);
  const stored = await encryptedKv.getItem(scope, BRIEFING_DISMISSALS_KEY);
  if (!isCurrentAuthEpoch(authEpoch) || isSignOutActive()) {
    return [];
  }
  if (stored === null) {
    return [];
  }
  const parsed = storedDismissalsSchema.safeParse(stored);
  if (!parsed.success) {
    await encryptedKv.removeItem(scope, BRIEFING_DISMISSALS_KEY);
    return [];
  }
  return parsed.data.filter(item => Date.parse(item.expiresAt) > Date.now());
}
