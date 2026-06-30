import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_oauth_clients,
  mcp_gateway_oauth_grants,
  organizations,
} from '@kilocode/db/schema';
import { MCPGatewayOAuthGrantStatus } from '@kilocode/db/schema-types';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { createGatewayRepository } from '@/lib/mcp-gateway/repository';
import { createOAuthGrantService } from '@/lib/mcp-gateway/oauth-grant-service';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';

function serializeTimestamp(value: string) {
  return new Date(value).toISOString();
}

export const mcpGatewayAuthorizationsRouter = createTRPCRouter({
  listMine: baseProcedure
    .input(
      z
        .object({
          ownerScope: z.enum(['personal', 'organization']).optional(),
          organizationId: z.string().uuid().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      if (input?.organizationId) {
        const isMember = await isOrganizationMember(input.organizationId, ctx.user.id);
        if (!isMember) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You are not a member of this organization',
          });
        }
      }
      const filterConditions = [
        eq(mcp_gateway_oauth_grants.kilo_user_id, ctx.user.id),
        eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Active),
        isNull(mcp_gateway_oauth_grants.revoked_at),
        isNull(mcp_gateway_oauth_clients.deleted_at),
        isNull(mcp_gateway_configs.deleted_at),
      ];
      if (input?.ownerScope) {
        filterConditions.push(eq(mcp_gateway_oauth_grants.owner_scope, input.ownerScope));
      }
      if (input?.organizationId) {
        filterConditions.push(eq(mcp_gateway_oauth_grants.owner_scope, 'organization'));
        filterConditions.push(eq(mcp_gateway_oauth_grants.owner_id, input.organizationId));
      }
      const rows = await db
        .select({
          grant: mcp_gateway_oauth_grants,
          client: mcp_gateway_oauth_clients,
          config: mcp_gateway_configs,
          route: mcp_gateway_connect_resources,
          organization: organizations,
        })
        .from(mcp_gateway_oauth_grants)
        .innerJoin(
          mcp_gateway_oauth_clients,
          eq(mcp_gateway_oauth_clients.oauth_client_id, mcp_gateway_oauth_grants.oauth_client_id)
        )
        .innerJoin(
          mcp_gateway_configs,
          eq(mcp_gateway_configs.config_id, mcp_gateway_oauth_grants.config_id)
        )
        .innerJoin(
          mcp_gateway_connect_resources,
          eq(
            mcp_gateway_connect_resources.connect_resource_id,
            mcp_gateway_oauth_grants.connect_resource_id
          )
        )
        .leftJoin(
          organizations,
          eq(sql<string>`${organizations.id}::text`, mcp_gateway_oauth_grants.owner_id)
        )
        .where(and(...filterConditions))
        .orderBy(desc(mcp_gateway_oauth_grants.approved_at));

      return rows.map(row => ({
        grantId: row.grant.oauth_grant_id,
        clientId: row.client.client_id,
        clientName: row.client.client_name,
        redirectUri: row.grant.redirect_uri,
        connectionName: row.config.name,
        configId: row.grant.config_id,
        context:
          row.grant.owner_scope === 'organization'
            ? {
                type: 'organization' as const,
                organizationId: row.grant.owner_id,
                organizationName: row.organization?.name ?? 'Organization',
              }
            : { type: 'personal' as const },
        scopes: row.grant.granted_scopes,
        approvedAt: serializeTimestamp(row.grant.approved_at),
        lastUsedAt: row.grant.last_used_at ? serializeTimestamp(row.grant.last_used_at) : null,
      }));
    }),

  revoke: baseProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repository = createGatewayRepository(db);
      const oauthGrantService = createOAuthGrantService(repository);
      const revoked = await oauthGrantService.revokeGrantForUser(
        input.grantId,
        ctx.user.id,
        'user_revoked'
      );
      if (!revoked) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Authorized client not found' });
      }
      return { grantId: revoked.oauth_grant_id };
    }),
});
