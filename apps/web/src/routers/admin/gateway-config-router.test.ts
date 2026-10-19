import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { AI_GATEWAY_CONFIG_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null), set: jest.fn(), del: jest.fn() },
}));

const redisSet = jest.mocked(redisClient.set);

let admin: User;

beforeEach(async () => {
  redisSet.mockReset();
  redisSet.mockResolvedValue('OK' as never);
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `gateway-config-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

describe('adminGatewayConfigRouter', () => {
  it('publishes the full gateway config snapshot read back from the primary after a write', async () => {
    const preferredModels = { models: ['provider/model-a'] };
    await db.insert(ai_gateway_config).values({ preferred_models: preferredModels });
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.gatewayConfig.set({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: [' Provider/Model-B '],
      note: null,
    });

    expect(redisSet).toHaveBeenCalledTimes(1);
    const [key, value, options] = redisSet.mock.calls[0];
    expect(key).toBe(AI_GATEWAY_CONFIG_REDIS_KEY);
    expect(options).toEqual({ ex: 300 });
    expect(JSON.parse(String(value))).toEqual({
      config,
      auto_free: null,
      unavailable_models: null,
      preferred_models: preferredModels,
    });
    expect(config.vercel_routing_opt_out_models).toEqual(['provider/model-b']);
  });
});
