import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import {
  GATEWAY_MODEL_LIST_MAX_COUNT,
  GatewayModelListConfigSchema,
  type GatewayModelListConfig,
} from '@kilocode/db/schema-types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import type { GatewayModelList } from '@/routers/admin/gateway-model-lists-router';

let admin: User;
let nonAdmin: User;

const config: GatewayModelListConfig = {
  models: ['kilo-auto/efficient', 'anthropic/claude-opus-5.5', 'provider/model-a:free'],
};

const lists: GatewayModelList[] = ['preferred_models', 'unavailable_models'];

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `gateway-model-lists-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `gateway-model-lists-user-${Math.random()}@example.com`,
  });
});

describe('GatewayModelListConfigSchema', () => {
  it('accepts an empty list', () => {
    expect(GatewayModelListConfigSchema.safeParse({ models: [] }).success).toBe(true);
  });

  it('rejects duplicate models', () => {
    const result = GatewayModelListConfigSchema.safeParse({
      models: ['provider/model-a', 'provider/model-a'],
    });
    expect(result.success).toBe(false);
  });

  it.each(['Provider/Model', 'provider/model_a', 'provider/model a', ''])(
    'rejects model ID %p',
    model => {
      expect(GatewayModelListConfigSchema.safeParse({ models: [model] }).success).toBe(false);
    }
  );

  it('rejects more than the maximum number of models', () => {
    const models = Array.from(
      { length: GATEWAY_MODEL_LIST_MAX_COUNT + 1 },
      (_, index) => `provider/model-${index}`
    );
    expect(GatewayModelListConfigSchema.safeParse({ models }).success).toBe(false);
  });
});

describe('adminGatewayModelListsRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(
      caller.admin.gatewayModelLists.get({ list: 'preferred_models' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.gatewayModelLists.set({ list: 'unavailable_models', config })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(lists)('returns no stored config for %s when unset', async list => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.gatewayModelLists.get({ list })).resolves.toEqual({ config: null });
  });

  it.each(lists)(
    'stores, updates, and clears %s without touching other gateway config',
    async list => {
      const autoFree = { models: [{ model: 'provider/model-a:free', weight: 1, reasoning: {} }] };
      await db
        .insert(ai_gateway_config)
        .values({ config: { vercel_routing_enabled: false }, auto_free: autoFree });
      const otherList = lists.find(other => other !== list) ?? list;
      const otherConfig: GatewayModelListConfig = { models: ['provider/other-model'] };
      const caller = await createCallerForUser(admin.id);
      await caller.admin.gatewayModelLists.set({ list: otherList, config: otherConfig });

      await caller.admin.gatewayModelLists.set({ list, config });
      expect((await caller.admin.gatewayModelLists.get({ list })).config).toEqual(config);

      const reordered: GatewayModelListConfig = { models: [...config.models].reverse() };
      await caller.admin.gatewayModelLists.set({ list, config: reordered });
      expect((await caller.admin.gatewayModelLists.get({ list })).config).toEqual(reordered);

      await caller.admin.gatewayModelLists.set({ list, config: null });
      expect((await caller.admin.gatewayModelLists.get({ list })).config).toBeNull();

      const [row] = await db.select().from(ai_gateway_config);
      expect(row).toMatchObject({
        config: { vercel_routing_enabled: false },
        auto_free: autoFree,
        [otherList]: otherConfig,
      });
    }
  );

  it('creates the singleton row when none exists', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.gatewayModelLists.set({ list: 'unavailable_models', config });

    const rows = await db.select().from(ai_gateway_config);
    expect(rows).toEqual([
      {
        id: 1,
        config: {},
        auto_free: null,
        preferred_models: null,
        unavailable_models: config,
        vercel_model_id_overrides: null,
        preferred_provider_order: null,
      },
    ]);
  });

  it('rejects an invalid list without writing', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.gatewayModelLists.set({
        list: 'preferred_models',
        config: { models: ['provider/model-a', 'provider/model-a'] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  it('rejects an unknown list name', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.gatewayModelLists.set({
        // @ts-expect-error verifying runtime validation of the column name
        list: 'auto_free',
        config,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
