import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import { VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `gateway-config-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

const input = {
  vercel_routing_enabled: false,
  vercel_routing_opt_out_models: [' MoonshotAI/Kimi-K3 ', 'moonshotai/kimi-k3', 'openai/gpt-6'],
  note: 'Holding opt-outs',
};

const normalizedOptOutModels = ['moonshotai/kimi-k3', 'openai/gpt-6'];

describe('adminGatewayConfigRouter', () => {
  it('stores the normalized opt-out list and reads it back', async () => {
    const caller = await createCallerForUser(admin.id);

    const saved = await caller.admin.gatewayConfig.set(input);
    expect({
      vercel_routing_enabled: saved.vercel_routing_enabled,
      vercel_routing_opt_out_models: saved.vercel_routing_opt_out_models,
      note: saved.note,
    }).toEqual({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    const [row] = await db.select().from(ai_gateway_config);
    expect(row.config).toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });
  });

  it('rejects a blank opt-out entry without writing', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.set({
        ...input,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3', ''],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  it('rejects an over-length opt-out entry without writing', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.set({
        ...input,
        vercel_routing_opt_out_models: ['x'.repeat(VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH + 1)],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  it('keeps organization features when the routing configuration is saved', async () => {
    const caller = await createCallerForUser(admin.id);
    const organizationId = '00000000-0000-4000-8000-000000000001';

    await caller.admin.gatewayConfig.setOrganizationFeatures({
      experimental_byok: [organizationId.toUpperCase()],
      gateway_disable_toggles: [],
      data_region: [organizationId],
    });
    await caller.admin.gatewayConfig.set(input);

    await expect(caller.admin.gatewayConfig.getOrganizationFeatures()).resolves.toEqual({
      experimental_byok: [organizationId],
      gateway_disable_toggles: [],
      data_region: [organizationId],
    });
    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
    });
  });

  it('keeps the routing configuration when organization features are saved', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.admin.gatewayConfig.set(input);
    await caller.admin.gatewayConfig.setOrganizationFeatures({
      experimental_byok: [],
      gateway_disable_toggles: ['00000000-0000-4000-8000-000000000001'],
      data_region: [],
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });
  });

  it('rejects an organization feature entry that is not an organization ID', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.setOrganizationFeatures({
        experimental_byok: ['not-an-id'],
        gateway_disable_toggles: [],
        data_region: [],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });
});
