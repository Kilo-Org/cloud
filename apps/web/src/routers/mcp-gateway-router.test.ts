import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { mcp_gateway_configs, mcp_gateway_connect_resources } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerFactory, createTRPCRouter } from '@/lib/trpc/init';
import { mcpGatewayRouter } from '@/routers/mcp-gateway-router';
import { findUserById } from '@/lib/user';

const createCaller = createCallerFactory(createTRPCRouter({ mcpGateway: mcpGatewayRouter }));

async function createCallerForUser(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error(`Test user not found: ${userId}`);
  return createCaller({ user });
}

describe('mcpGateway admin rollout', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('denies non-admin users', async () => {
    const user = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(user.id);
    await expect(caller.mcpGateway.listPersonal(undefined)).rejects.toThrow(
      'Admin access required'
    );
  });

  it('allows admin users to list personal connections', async () => {
    const user = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(user.id);
    await expect(caller.mcpGateway.listPersonal(undefined)).resolves.toEqual([]);
  });

  it('does not allow an admin to mutate another admins personal connection', async () => {
    const owner = await insertTestUser({ is_admin: true });
    const otherAdmin = await insertTestUser({ is_admin: true });
    const otherCaller = await createCallerForUser(otherAdmin.id);
    const [config] = await db
      .insert(mcp_gateway_configs)
      .values({
        owner_scope: 'personal',
        owner_id: owner.id,
        name: 'Personal MCP',
        remote_url: 'https://example.com/mcp',
        auth_mode: 'none',
        sharing_mode: 'single_user',
        created_by_kilo_user_id: owner.id,
      })
      .returning();
    await db.insert(mcp_gateway_connect_resources).values({
      config_id: config.config_id,
      owner_scope: 'personal',
      owner_id: owner.id,
      route_key: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      canonical_url: `https://mcp.kilo.ai/mcp-connect/user/${owner.id}/${config.config_id}/abcdefghijklmnopqrstuvwxyzABCDEF`,
    });

    await expect(
      otherCaller.mcpGateway.rotateRoute({ configId: config.config_id })
    ).rejects.toThrow('Connection not found');
  });
});
