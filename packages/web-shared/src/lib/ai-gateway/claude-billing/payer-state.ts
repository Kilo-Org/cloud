import 'server-only';
import { z } from 'zod';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getClaudeBillingConnection, type ClaudeBillingOwner } from './store';
import { fetchClaudeWithRetry } from '@kilocode/web-shared/lib/auth/claude/http';

export const ClaudeBillingOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), kiloUserId: z.string().min(1) }),
  z.object({ kind: z.literal('organization'), organizationId: z.uuid() }),
]) satisfies z.ZodType<ClaudeBillingOwner>;

export const ClaudeBillingPayerStateSchema = z.object({
  status: z.enum(ClaudeBillingConnectionStatus),
  user_profile_id: z.string().min(1),
  connected_at: z.iso.datetime().nullable(),
});
export type ClaudeBillingPayerState = z.infer<typeof ClaudeBillingPayerStateSchema>;
const responseSchema = z.object({ connection: ClaudeBillingPayerStateSchema.nullable() });

export function claudeBillingPayerState(
  row: ClaudeBillingConnectionRow | null
): ClaudeBillingPayerState | null {
  return row
    ? {
        status: row.status,
        user_profile_id: row.user_profile_id,
        connected_at: row.connected_at ? new Date(row.connected_at).toISOString() : null,
      }
    : null;
}

export async function getAuthoritativeClaudeBillingState(
  owner: ClaudeBillingOwner
): Promise<ClaudeBillingPayerState | null> {
  // A stale absent row would switch payer after connect. Read the primary in
  // Frankfurt; SFO delegates there without holding a cross-region pool connection.
  if (!isUSRegion()) return claudeBillingPayerState(await getClaudeBillingConnection(owner, db));
  if (!INTERNAL_API_SECRET) throw new Error('Claude payer-state authentication is not configured');
  const response = await fetchClaudeWithRetry(
    new URL('/api/internal/claude-billing/payer-state', APP_URL).toString(),
    async () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-api-key': INTERNAL_API_SECRET },
      body: JSON.stringify(owner),
      cache: 'no-store',
    }),
    status => status === 429 || status >= 500,
    AbortSignal.timeout(15_000)
  );
  if (!response.ok) throw new Error(`Claude payer-state read failed with HTTP ${response.status}`);
  return responseSchema.parse(await response.json()).connection;
}
