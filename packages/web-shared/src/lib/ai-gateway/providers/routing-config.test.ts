import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';

// Each case imports the module into a fresh registry, because the getter caches its value for 60 s
// at module scope and would otherwise serve the first case's answer to every later one.
describe('getRuntimeGatewayRoutingConfig', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('resolves the built-in default when no config row exists', async () => {
    await jest.isolateModulesAsync(async () => {
      const { getRuntimeGatewayRoutingConfig } = await import('./routing-config');
      expect(await getRuntimeGatewayRoutingConfig()).toEqual({
        vercelOptOutModels: new Set(),
      });
    });
  });

  it('resolves an empty set for a stored empty config object', async () => {
    await db.insert(ai_gateway_config).values({ config: {} });
    await jest.isolateModulesAsync(async () => {
      const { getRuntimeGatewayRoutingConfig } = await import('./routing-config');
      expect(await getRuntimeGatewayRoutingConfig()).toEqual({
        vercelOptOutModels: new Set(),
      });
    });
  });

  it('resolves the stored routing opt-out models', async () => {
    await db.insert(ai_gateway_config).values({
      config: { vercel_routing_opt_out_models: ['provider/a', 'provider/b'] },
    });
    await jest.isolateModulesAsync(async () => {
      const { getRuntimeGatewayRoutingConfig } = await import('./routing-config');
      expect(await getRuntimeGatewayRoutingConfig()).toEqual({
        vercelOptOutModels: new Set(['provider/a', 'provider/b']),
      });
    });
  });

  it('resolves the built-in default for an invalid stored config instead of rejecting', async () => {
    await db
      .insert(ai_gateway_config)
      .values({ config: { vercel_routing_opt_out_models: 'not-an-array' } });
    await jest.isolateModulesAsync(async () => {
      const { getRuntimeGatewayRoutingConfig } = await import('./routing-config');
      await expect(getRuntimeGatewayRoutingConfig()).resolves.toEqual({
        vercelOptOutModels: new Set(),
      });
    });
  });
});
