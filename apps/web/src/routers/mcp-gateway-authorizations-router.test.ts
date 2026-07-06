import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_connection_instances,
  mcp_gateway_oauth_clients,
  mcp_gateway_oauth_grants,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerFactory, createTRPCRouter } from '@/lib/trpc/init';
import { findUserById } from '@/lib/user';
import { mcpGatewayAuthorizationsRouter } from '@/routers/mcp-gateway-authorizations-router';
import { eq } from 'drizzle-orm';

const createCaller = createCallerFactory(
  createTRPCRouter({ mcpGatewayAuthorizations: mcpGatewayAuthorizationsRouter })
);

async function createCallerForUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error(`Test user not found: ${userId}`);
  return createCaller({ user });
}

async function seedGrant(userId: string, ownerScope: 'personal' | 'organization' = 'personal') {
  const ownerId = ownerScope === 'personal' ? userId : crypto.randomUUID();
  const routeKey = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const [config] = await db
    .insert(mcp_gateway_configs)
    .values({
      owner_scope: ownerScope,
      owner_id: ownerId,
      name: ownerScope === 'personal' ? 'Personal MCP' : 'Organization MCP',
      remote_url: 'https://example.com/mcp',
      auth_mode: 'none',
      sharing_mode: ownerScope === 'personal' ? 'single_user' : 'multi_user',
      created_by_kilo_user_id: userId,
    })
    .returning();
  const [route] = await db
    .insert(mcp_gateway_connect_resources)
    .values({
      config_id: config.config_id,
      owner_scope: ownerScope,
      owner_id: ownerId,
      route_key: routeKey,
      canonical_url: `https://mcp.kilo.ai/mcp-connect/user/${userId}/${config.config_id}/${routeKey}`,
    })
    .returning();
  const [instance] = await db
    .insert(mcp_gateway_connection_instances)
    .values({
      config_id: config.config_id,
      owner_scope: ownerScope,
      owner_id: ownerId,
      kilo_user_id: userId,
    })
    .returning();
  const [client] = await db
    .insert(mcp_gateway_oauth_clients)
    .values({
      client_id: `mcp:${crypto.randomUUID().replaceAll('-', '')}`,
      registration_token_hash: crypto.randomUUID(),
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://localhost:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      declared_scopes: ['mcp:access'],
    })
    .returning();
  const [grant] = await db
    .insert(mcp_gateway_oauth_grants)
    .values({
      oauth_client_id: client.oauth_client_id,
      kilo_user_id: userId,
      owner_scope: ownerScope,
      owner_id: ownerId,
      config_id: config.config_id,
      connect_resource_id: route.connect_resource_id,
      instance_id: instance.instance_id,
      redirect_uri: 'http://localhost:3000/callback',
      granted_scopes: ['mcp:access'],
      execution_context:
        ownerScope === 'personal'
          ? { type: 'personal' }
          : { type: 'organization', organizationId: ownerId },
      config_version: 1,
    })
    .returning();
  return { grant, client, config, route, instance };
}

describe('mcpGatewayAuthorizationsRouter', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('lists only the current user grants', async () => {
    const user = await insertTestUser({ is_admin: false });
    const otherUser = await insertTestUser({ is_admin: false });
    const owned = await seedGrant(user.id);
    await seedGrant(otherUser.id);
    const caller = await createCallerForUser(user.id);

    const grants = await caller.mcpGatewayAuthorizations.listMine(undefined);

    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantId).toBe(owned.grant.oauth_grant_id);
    expect(grants[0]?.connectionName).toBe('Personal MCP');
  });

  it('requires organization membership for organization-scoped listing', async () => {
    const user = await insertTestUser({ is_admin: false });
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Test Organization' })
      .returning();
    const owned = await seedGrant(user.id, 'organization');
    await db
      .update(mcp_gateway_configs)
      .set({ owner_id: organization.id })
      .where(eq(mcp_gateway_configs.config_id, owned.config.config_id));
    await db
      .update(mcp_gateway_connect_resources)
      .set({ owner_id: organization.id })
      .where(
        eq(mcp_gateway_connect_resources.connect_resource_id, owned.route.connect_resource_id)
      );
    await db
      .update(mcp_gateway_connection_instances)
      .set({ owner_id: organization.id })
      .where(eq(mcp_gateway_connection_instances.instance_id, owned.instance.instance_id));
    await db
      .update(mcp_gateway_oauth_grants)
      .set({
        owner_id: organization.id,
        execution_context: { type: 'organization', organizationId: organization.id },
      })
      .where(eq(mcp_gateway_oauth_grants.oauth_grant_id, owned.grant.oauth_grant_id));
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.mcpGatewayAuthorizations.listMine({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: user.id,
      role: 'member',
    });

    await expect(
      caller.mcpGatewayAuthorizations.listMine({ organizationId: organization.id })
    ).resolves.toHaveLength(1);
  });

  it('revokes only the selected current user grant', async () => {
    const user = await insertTestUser({ is_admin: false });
    const otherUser = await insertTestUser({ is_admin: false });
    const owned = await seedGrant(user.id);
    const other = await seedGrant(otherUser.id);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.mcpGatewayAuthorizations.revoke({ grantId: other.grant.oauth_grant_id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await caller.mcpGatewayAuthorizations.revoke({ grantId: owned.grant.oauth_grant_id });

    const [revoked] = await db
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(eq(mcp_gateway_oauth_grants.oauth_grant_id, owned.grant.oauth_grant_id));
    const [unchanged] = await db
      .select()
      .from(mcp_gateway_oauth_grants)
      .where(eq(mcp_gateway_oauth_grants.oauth_grant_id, other.grant.oauth_grant_id));
    expect(revoked?.revoked_at).toBeTruthy();
    expect(unchanged?.revoked_at).toBeNull();
  });
});
