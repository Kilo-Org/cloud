import 'server-only';
import { sql } from 'drizzle-orm';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createClaudeUserProfile } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { resolveClaudeBillingConnector } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/connector';
import {
  claudeBillingOwnerKey,
  getGrantedClaudeBillingConnection,
  insertClaudeBillingProfile,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { cleanupRemovedClaudeProfilesForUser } from '@/lib/claude-billing/delete';

/** The state a connection row reports, which the card and the router share. */
export type ClaudeBillingConnectionState =
  | 'not_connected'
  | 'connected'
  | 'billing_unavailable'
  | 'pending'
  /** A live organization connection whose connector is gone; an owner reconnects it. */
  | 'reconnect_required';

/**
 * The row's own state, plus the reconnect requirement of a shared-services row.
 * The organization's shared connection bills its service runs on whoever linked
 * it, so a row whose connector cannot pass that check reads as needing a
 * reconnect instead of as connected. Every other row keeps its stored state.
 */
export async function claudeBillingConnectionState(
  owner: ClaudeBillingOwner,
  row: ClaudeBillingConnectionRow | null
): Promise<ClaudeBillingConnectionState> {
  if (!row || row.status === ClaudeBillingConnectionStatus.Removed) return 'not_connected';
  if (row.status === ClaudeBillingConnectionStatus.Pending) return 'pending';
  if (row.status === ClaudeBillingConnectionStatus.BillingUnavailable) return 'billing_unavailable';
  if (owner.kind !== 'shared_services') return 'connected';
  const connector = await resolveClaudeBillingConnector(row.created_by, db);
  return connector.kind === 'gone' ? 'reconnect_required' : 'connected';
}

/**
 * Resolves the Anthropic user profile for an OAuth link attempt. An active or
 * pending scope reuses its profile; an unlinked scope gets a fresh profile so a
 * person can link different Claude organizations across scopes.
 */
export async function ensureClaudeBillingProfile(
  owner: ClaudeBillingOwner,
  createdBy: string
): Promise<{ userProfileId: string; connectionVersion: string }> {
  await cleanupRemovedClaudeProfilesForUser(createdBy, { limit: 3, timeoutMs: 3_000 }).catch(
    () => undefined
  );
  const lockKey = claudeBillingOwnerKey(owner);

  return await db.transaction(async tx => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`claude_billing_profile:${lockKey}`}))`
    );
    const active = await getGrantedClaudeBillingConnection(owner, tx);
    if (active && active.status !== ClaudeBillingConnectionStatus.Removed) {
      return { userProfileId: active.user_profile_id, connectionVersion: active.updated_at };
    }

    const userProfileId = await createClaudeUserProfile();
    const row = await insertClaudeBillingProfile(owner, userProfileId, createdBy, tx);
    return { userProfileId: row.user_profile_id, connectionVersion: row.updated_at };
  });
}
