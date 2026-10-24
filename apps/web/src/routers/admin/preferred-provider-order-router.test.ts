import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

const config: PreferredProviderOrderConfig = {
  rules: [
    { includes: ['openai', 'gpt'], excludes: ['gpt-oss'], providers: ['openai'] },
    { includes: ['claude'], providers: ['amazon-bedrock', 'google-vertex'] },
    { includes: ['minimax'], providers: ['minimax/fp8'] },
  ],
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `provider-order-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `provider-order-user-${Math.random()}@example.com`,
  });
});

describe('adminPreferredProviderOrderRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.preferredProviderOrder.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.preferredProviderOrder.set({ config })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns no stored config when unset', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.preferredProviderOrder.get()).resolves.toEqual({ config: null });
  });

  it('stores, updates, and clears the config without touching other columns', async () => {
    const preferredModels = { models: ['provider/model-a'] };
    await db.insert(ai_gateway_config).values({
      config: { vercel_routing_enabled: false },
      preferred_models: preferredModels,
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.preferredProviderOrder.set({ config });
    expect((await caller.admin.preferredProviderOrder.get()).config).toEqual(config);

    const updated: PreferredProviderOrderConfig = { rules: [config.rules[1]] };
    await caller.admin.preferredProviderOrder.set({ config: updated });
    expect((await caller.admin.preferredProviderOrder.get()).config).toEqual(updated);

    await caller.admin.preferredProviderOrder.set({ config: null });
    expect((await caller.admin.preferredProviderOrder.get()).config).toBeNull();

    const [row] = await db.select().from(ai_gateway_config);
    expect(row).toMatchObject({
      config: { vercel_routing_enabled: false },
      preferred_models: preferredModels,
    });
  });

  it('keeps the rule order', async () => {
    const caller = await createCallerForUser(admin.id);
    const reversed: PreferredProviderOrderConfig = { rules: [...config.rules].reverse() };
    await caller.admin.preferredProviderOrder.set({ config: reversed });
    expect((await caller.admin.preferredProviderOrder.get()).config).toEqual(reversed);
  });

  it('creates the singleton row when none exists', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.preferredProviderOrder.set({ config });

    const rows = await db.select().from(ai_gateway_config);
    expect(rows).toEqual([
      {
        id: 1,
        config: {},
        auto_free: null,
        preferred_models: null,
        unavailable_models: null,
        vercel_model_id_overrides: null,
        preferred_provider_order: config,
      },
    ]);
  });

  it('rejects an invalid config without writing', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.preferredProviderOrder.set({
        config: { rules: [{ includes: ['gpt'], excludes: ['gpt'], providers: ['openai'] }] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });
});
