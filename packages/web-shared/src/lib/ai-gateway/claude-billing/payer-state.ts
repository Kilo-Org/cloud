import 'server-only';
import { z } from 'zod';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getGrantedClaudeBillingConnection, type ClaudeBillingOwner } from './store';
import { claudeBillingOwnerMatches } from './owner';
import { fetchClaudeWithRetry } from '@kilocode/web-shared/lib/auth/claude/http';

/**
 * The owner a pending link completes and the owner of the internal payer-state
 * wire between the gateway and the web app. The two deployments release
 * separately, so each side reads the other's previous release: an organization
 * owner arrives with fields this release no longer names, and parsing ignores
 * them.
 */
export const ClaudeBillingOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), kiloUserId: z.string().min(1) }),
  z.object({ kind: z.literal('organization'), organizationId: z.uuid() }),
]) satisfies z.ZodType<ClaudeBillingOwner>;

export const ClaudeBillingPayerStateSchema = z.object({
  status: z.enum(ClaudeBillingConnectionStatus),
  user_profile_id: z.string().min(1),
  connected_at: z.iso.datetime().nullable(),
  /**
   * The person a personal row belongs to, null for an organization row. The
   * cross-region read requires the requesting person for a personal owner and
   * null for an organization owner.
   */
  kilo_user_id: z.string().nullable().optional(),
  /**
   * The organization an organization row belongs to, null for a personal row.
   * The cross-region read requires the requested organization for an
   * organization owner, and null or absent for a personal owner.
   */
  organization_id: z.uuid().nullable().optional(),
  /** The person who linked it last; every release since #10300 answers with it. */
  created_by: z.string().min(1).optional(),
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
        kilo_user_id: row.kilo_user_id,
        organization_id: row.organization_id,
        created_by: row.created_by,
      }
    : null;
}

export async function getAuthoritativeClaudeBillingState(
  owner: ClaudeBillingOwner
): Promise<ClaudeBillingPayerState | null> {
  // A stale absent row would switch payer after connect. Read the primary in
  // Frankfurt; SFO delegates there without holding a cross-region pool connection.
  if (!isUSRegion())
    return claudeBillingPayerState(await getGrantedClaudeBillingConnection(owner, db));
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
  const { connection } = responseSchema.parse(await response.json());
  if (!connection || !claudeBillingOwnerMatches(connection, owner)) return null;
  return connection;
}
