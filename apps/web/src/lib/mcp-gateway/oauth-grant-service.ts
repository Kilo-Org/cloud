import 'server-only';
import {
  GatewayAuthorizationRequestStatus,
  GatewayPendingProviderAuthorizationStatus,
  executionContextsMatch,
  type GatewayExecutionContext,
  type GatewayOwnerScope,
} from '@kilocode/mcp-gateway';
import { MCPGatewayOAuthGrantStatus } from '@kilocode/db/schema-types';
import {
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_audit_events,
  mcp_gateway_oauth_grants,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { GatewayRepository } from './repository';

function sameScopes(left: string[], right: string[]) {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

type GrantTx = GatewayRepository['database'];

export async function revokeGrantIdsWithTx(
  tx: GrantTx,
  grantIds: string[],
  reason: string,
  actorUserId: string | null = null
) {
  if (grantIds.length === 0) return [];
  const revokedAt = new Date().toISOString();

  await tx
    .update(mcp_gateway_authorization_requests)
    .set({
      request_status: GatewayAuthorizationRequestStatus.Error,
      consumed_at: revokedAt,
    })
    .where(
      and(
        inArray(mcp_gateway_authorization_requests.oauth_grant_id, grantIds),
        eq(
          mcp_gateway_authorization_requests.request_status,
          GatewayAuthorizationRequestStatus.Pending
        )
      )
    );
  await tx
    .update(mcp_gateway_authorization_codes)
    .set({ consumed_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_authorization_codes.oauth_grant_id, grantIds),
        isNull(mcp_gateway_authorization_codes.consumed_at)
      )
    );
  await tx
    .update(mcp_gateway_refresh_tokens)
    .set({ revoked_at: revokedAt })
    .where(
      and(
        inArray(mcp_gateway_refresh_tokens.oauth_grant_id, grantIds),
        isNull(mcp_gateway_refresh_tokens.revoked_at)
      )
    );
  await tx
    .update(mcp_gateway_pending_provider_authorizations)
    .set({
      pending_status: GatewayPendingProviderAuthorizationStatus.Error,
      consumed_at: revokedAt,
    })
    .where(
      and(
        inArray(mcp_gateway_pending_provider_authorizations.oauth_grant_id, grantIds),
        eq(
          mcp_gateway_pending_provider_authorizations.pending_status,
          GatewayPendingProviderAuthorizationStatus.Pending
        )
      )
    );

  const revoked = await tx
    .update(mcp_gateway_oauth_grants)
    .set({
      grant_status: MCPGatewayOAuthGrantStatus.Revoked,
      revoked_at: revokedAt,
      revocation_reason: reason,
    })
    .where(
      and(
        inArray(mcp_gateway_oauth_grants.oauth_grant_id, grantIds),
        isNull(mcp_gateway_oauth_grants.revoked_at)
      )
    )
    .returning();
  if (revoked.length > 0) {
    await tx.insert(mcp_gateway_audit_events).values(
      revoked.map(grant => ({
        actor_kilo_user_id: actorUserId,
        owner_scope: grant.owner_scope,
        owner_id: grant.owner_id,
        config_id: grant.config_id,
        connect_resource_id: grant.connect_resource_id,
        instance_id: grant.instance_id,
        oauth_grant_id: grant.oauth_grant_id,
        event_type: 'oauth_grant_revoked',
        outcome: 'success' as const,
        correlation_metadata: { reason },
      }))
    );
  }
  return revoked;
}

export function createOAuthGrantService(repository: GatewayRepository) {
  const { database } = repository;

  async function revokeGrantIds(
    grantIds: string[],
    reason: string,
    actorUserId: string | null = null
  ) {
    return await revokeGrantIdsWithTx(database, grantIds, reason, actorUserId);
  }

  function isReusableGrant(
    grant: typeof mcp_gateway_oauth_grants.$inferSelect,
    input: {
      instanceId: string;
      configVersion: number;
      grantedScopes: string[];
      executionContext: GatewayExecutionContext;
      grantStatus?: MCPGatewayOAuthGrantStatus;
    }
  ) {
    return (
      grant.instance_id === input.instanceId &&
      grant.config_version === input.configVersion &&
      sameScopes(grant.granted_scopes, input.grantedScopes) &&
      executionContextsMatch(grant.execution_context, input.executionContext)
    );
  }

  async function createOrReuseGrant(input: {
    oauthClientId: string;
    kiloUserId: string;
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    connectResourceId: string;
    instanceId: string;
    redirectUri: string;
    grantedScopes: string[];
    executionContext: GatewayExecutionContext;
    grantStatus?: MCPGatewayOAuthGrantStatus;
    configVersion: number;
  }) {
    const grantStatus = input.grantStatus ?? MCPGatewayOAuthGrantStatus.Active;
    const existingRows = await database
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_client_id, input.oauthClientId),
          eq(mcp_gateway_oauth_grants.kilo_user_id, input.kiloUserId),
          eq(mcp_gateway_oauth_grants.connect_resource_id, input.connectResourceId),
          eq(mcp_gateway_oauth_grants.redirect_uri, input.redirectUri),
          inArray(mcp_gateway_oauth_grants.grant_status, [
            MCPGatewayOAuthGrantStatus.Pending,
            MCPGatewayOAuthGrantStatus.Active,
          ]),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing && existing.grant_status === grantStatus && isReusableGrant(existing, input)) {
      const [updated] = await database
        .update(mcp_gateway_oauth_grants)
        .set({ approved_at: new Date().toISOString(), grant_status: grantStatus })
        .where(eq(mcp_gateway_oauth_grants.oauth_grant_id, existing.oauth_grant_id))
        .returning();
      return updated ?? existing;
    }

    if (existing) {
      await revokeGrantIds([existing.oauth_grant_id], 'authorization_binding_changed');
    }

    const [created] = await database
      .insert(mcp_gateway_oauth_grants)
      .values({
        oauth_client_id: input.oauthClientId,
        kilo_user_id: input.kiloUserId,
        owner_scope: input.ownerScope,
        owner_id: input.ownerId,
        config_id: input.configId,
        connect_resource_id: input.connectResourceId,
        instance_id: input.instanceId,
        redirect_uri: input.redirectUri,
        granted_scopes: input.grantedScopes,
        execution_context: input.executionContext,
        grant_status: grantStatus,
        config_version: input.configVersion,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [conflicted] = await database
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_client_id, input.oauthClientId),
          eq(mcp_gateway_oauth_grants.kilo_user_id, input.kiloUserId),
          eq(mcp_gateway_oauth_grants.connect_resource_id, input.connectResourceId),
          eq(mcp_gateway_oauth_grants.redirect_uri, input.redirectUri),
          inArray(mcp_gateway_oauth_grants.grant_status, [
            MCPGatewayOAuthGrantStatus.Pending,
            MCPGatewayOAuthGrantStatus.Active,
          ]),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .limit(1);
    if (!conflicted) {
      throw new Error('Failed to create gateway OAuth grant');
    }
    if (conflicted.grant_status === grantStatus && isReusableGrant(conflicted, input)) {
      return conflicted;
    }
    await revokeGrantIds([conflicted.oauth_grant_id], 'authorization_binding_changed');
    const [retried] = await database
      .insert(mcp_gateway_oauth_grants)
      .values({
        oauth_client_id: input.oauthClientId,
        kilo_user_id: input.kiloUserId,
        owner_scope: input.ownerScope,
        owner_id: input.ownerId,
        config_id: input.configId,
        connect_resource_id: input.connectResourceId,
        instance_id: input.instanceId,
        redirect_uri: input.redirectUri,
        granted_scopes: input.grantedScopes,
        execution_context: input.executionContext,
        grant_status: grantStatus,
        config_version: input.configVersion,
      })
      .onConflictDoNothing()
      .returning();
    if (retried) return retried;
    const [reracedRow] = await database
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_client_id, input.oauthClientId),
          eq(mcp_gateway_oauth_grants.kilo_user_id, input.kiloUserId),
          eq(mcp_gateway_oauth_grants.connect_resource_id, input.connectResourceId),
          eq(mcp_gateway_oauth_grants.redirect_uri, input.redirectUri),
          inArray(mcp_gateway_oauth_grants.grant_status, [
            MCPGatewayOAuthGrantStatus.Pending,
            MCPGatewayOAuthGrantStatus.Active,
          ]),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .limit(1);
    if (
      reracedRow &&
      reracedRow.grant_status === grantStatus &&
      isReusableGrant(reracedRow, input)
    ) {
      return reracedRow;
    }
    throw new Error('Failed to create gateway OAuth grant after binding conflict');
  }

  async function touchGrant(grantId: string) {
    await database
      .update(mcp_gateway_oauth_grants)
      .set({ last_used_at: new Date().toISOString() })
      .where(eq(mcp_gateway_oauth_grants.oauth_grant_id, grantId));
  }

  async function activateGrant(grantId: string) {
    const [grant] = await database
      .update(mcp_gateway_oauth_grants)
      .set({
        grant_status: MCPGatewayOAuthGrantStatus.Active,
        approved_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_grant_id, grantId),
          eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Pending),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .returning();
    return grant ?? null;
  }

  async function findActiveGrant(grantId: string) {
    const rows = await database
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_grant_id, grantId),
          eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Active),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function revokeByClientIdWithTx(tx: GrantTx, oauthClientId: string, reason: string) {
    const rows = await tx
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_client_id, oauthClientId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIdsWithTx(
      tx,
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeByClientId(oauthClientId: string, reason: string) {
    return await revokeByClientIdWithTx(database, oauthClientId, reason);
  }

  async function revokeByConfigId(configId: string, reason: string) {
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.config_id, configId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIds(
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeByConnectResourceId(connectResourceId: string, reason: string) {
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.connect_resource_id, connectResourceId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIds(
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeByInstanceId(instanceId: string, reason: string) {
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.instance_id, instanceId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIds(
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeAllForUser(userId: string, reason: string) {
    return await revokeAllForUsers([userId], reason);
  }

  async function revokeAllForUsers(userIds: string[], reason: string) {
    if (userIds.length === 0) return [];
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          inArray(mcp_gateway_oauth_grants.kilo_user_id, userIds),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIds(
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeForOrganizationMember(
    organizationId: string,
    userId: string,
    reason: string
  ) {
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.owner_scope, 'organization'),
          eq(mcp_gateway_oauth_grants.owner_id, organizationId),
          eq(mcp_gateway_oauth_grants.kilo_user_id, userId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      );
    return await revokeGrantIds(
      rows.map(row => row.grantId),
      reason
    );
  }

  async function revokeGrantForUser(grantId: string, userId: string, reason: string) {
    const rows = await database
      .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
      .from(mcp_gateway_oauth_grants)
      .where(
        and(
          eq(mcp_gateway_oauth_grants.oauth_grant_id, grantId),
          eq(mcp_gateway_oauth_grants.kilo_user_id, userId),
          isNull(mcp_gateway_oauth_grants.revoked_at)
        )
      )
      .limit(1);
    if (!rows[0]) return null;
    const [revoked] = await revokeGrantIds([rows[0].grantId], reason, userId);
    return revoked ?? null;
  }

  return {
    createOrReuseGrant,
    findActiveGrant,
    activateGrant,
    touchGrant,
    revokeGrantIds,
    revokeByClientId,
    revokeByClientIdWithTx,
    revokeByConfigId,
    revokeByConnectResourceId,
    revokeByInstanceId,
    revokeAllForUser,
    revokeAllForUsers,
    revokeForOrganizationMember,
    revokeGrantForUser,
  };
}

export type GatewayOAuthGrantService = ReturnType<typeof createOAuthGrantService>;
