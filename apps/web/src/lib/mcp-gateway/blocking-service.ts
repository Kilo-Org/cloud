import 'server-only';

import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_oauth_grants,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

async function revokeGrantsForUsers(userIds: string[], reason: string) {
  if (userIds.length === 0) return;

  const grants = await db
    .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
    .from(mcp_gateway_oauth_grants)
    .where(
      and(
        inArray(mcp_gateway_oauth_grants.kilo_user_id, userIds),
        isNull(mcp_gateway_oauth_grants.revoked_at)
      )
    );
  const grantIds = grants.map(grant => grant.grantId);
  if (grantIds.length === 0) return;

  const revokedAt = new Date().toISOString();

  await db
    .update(mcp_gateway_authorization_requests)
    .set({ request_status: 'error', consumed_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_authorization_requests.oauth_grant_id, grantIds),
        eq(mcp_gateway_authorization_requests.request_status, 'pending')
      )
    );
  await db
    .update(mcp_gateway_authorization_codes)
    .set({ consumed_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_authorization_codes.oauth_grant_id, grantIds),
        isNull(mcp_gateway_authorization_codes.consumed_at)
      )
    );
  await db
    .update(mcp_gateway_refresh_tokens)
    .set({ revoked_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_refresh_tokens.oauth_grant_id, grantIds),
        isNull(mcp_gateway_refresh_tokens.revoked_at)
      )
    );
  await db
    .update(mcp_gateway_pending_provider_authorizations)
    .set({ pending_status: 'error', consumed_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_pending_provider_authorizations.oauth_grant_id, grantIds),
        eq(mcp_gateway_pending_provider_authorizations.pending_status, 'pending')
      )
    );
  await db
    .update(mcp_gateway_oauth_grants)
    .set({ grant_status: 'revoked', revoked_at: revokedAt, revocation_reason: reason })
    .where(
      and(
        inArray(mcp_gateway_oauth_grants.oauth_grant_id, grantIds),
        isNull(mcp_gateway_oauth_grants.revoked_at)
      )
    );
}

export async function revokeGatewayGrantsForBlockedUser(userId: string) {
  await revokeGrantsForUsers([userId], 'user_blocked');
}

export async function revokeGatewayGrantsForBlockedUsers(userIds: string[]) {
  await revokeGrantsForUsers(userIds, 'user_blocked');
}
