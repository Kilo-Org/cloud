import 'server-only';
import { z } from 'zod';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getGrantedClaudeBillingConnection, type ClaudeBillingOwner } from './store';
import { fetchClaudeWithRetry } from '@kilocode/web-shared/lib/auth/claude/http';

export const ClaudeBillingOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), kiloUserId: z.string().min(1) }),
  z.object({
    kind: z.literal('member'),
    kiloUserId: z.string().min(1),
    organizationId: z.uuid(),
  }),
  z.object({ kind: z.literal('shared_services'), organizationId: z.uuid() }),
]) satisfies z.ZodType<ClaudeBillingOwner>;

/**
 * The owner on the internal payer-state wire between the gateway and the web
 * app. The gateway deploys first, so each side must read the other's previous
 * release: `organization` alone names the shared-services connection, which is
 * the organization connection that release knew, and `organization` with a
 * person names that member's own connection.
 */
export const ClaudeBillingPayerOwnerSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('personal'), kiloUserId: z.string().min(1) }),
    z.object({
      kind: z.literal('organization'),
      organizationId: z.uuid(),
      kiloUserId: z.string().min(1).optional(),
    }),
  ])
  .transform((wire): ClaudeBillingOwner => {
    if (wire.kind === 'personal') return wire;
    return wire.kiloUserId
      ? { kind: 'member', kiloUserId: wire.kiloUserId, organizationId: wire.organizationId }
      : { kind: 'shared_services', organizationId: wire.organizationId };
  });

function payerOwnerWire(owner: ClaudeBillingOwner): z.input<typeof ClaudeBillingPayerOwnerSchema> {
  switch (owner.kind) {
    case 'personal':
      return owner;
    case 'member':
      return {
        kind: 'organization',
        organizationId: owner.organizationId,
        kiloUserId: owner.kiloUserId,
      };
    case 'shared_services':
      return { kind: 'organization', organizationId: owner.organizationId };
  }
}

export const ClaudeBillingPayerStateSchema = z.object({
  status: z.enum(ClaudeBillingConnectionStatus),
  user_profile_id: z.string().min(1),
  connected_at: z.iso.datetime().nullable(),
  /** The person the row belongs to; absent from the previous web app release. */
  kilo_user_id: z.string().nullable().optional(),
  /** The person who linked it last; absent from the previous web app release. */
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
      body: JSON.stringify(payerOwnerWire(owner)),
      cache: 'no-store',
    }),
    status => status === 429 || status >= 500,
    AbortSignal.timeout(15_000)
  );
  if (!response.ok) throw new Error(`Claude payer-state read failed with HTTP ${response.status}`);
  const { connection } = responseSchema.parse(await response.json());
  // A personal or member row belongs to the person it names, so the read
  // returns it only for that person. A shared-services row belongs to the
  // organization and names no person.
  if (owner.kind !== 'shared_services' && connection?.kilo_user_id !== owner.kiloUserId) {
    return null;
  }
  return connection;
}
