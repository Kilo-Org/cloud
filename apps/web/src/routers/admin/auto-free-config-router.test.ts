import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';
import { autoFreeModels } from '@/lib/ai-gateway/models';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

const config: AutoFreeConfig = {
  models: [
    { model: 'provider/model-a:free', weight: 2, reasoning: { enabled: true, effort: 'high' } },
    { model: 'provider/model-b:free', weight: 1, reasoning: { enabled: false } },
  ],
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `auto-free-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `auto-free-user-${Math.random()}@example.com`,
  });
});

describe('AutoFreeConfigSchema', () => {
  it('accepts the compiled auto-free models', () => {
    expect(AutoFreeConfigSchema.safeParse({ models: autoFreeModels }).success).toBe(true);
  });

  it('rejects duplicate models', () => {
    const result = AutoFreeConfigSchema.safeParse({
      models: [config.models[0], config.models[0]],
    });
    expect(result.success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects weight %s', weight => {
    const result = AutoFreeConfigSchema.safeParse({
      models: [{ ...config.models[0], weight }],
    });
    expect(result.success).toBe(false);
  });
});

describe('adminAutoFreeConfigRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.autoFreeConfig.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.admin.autoFreeConfig.set({ config })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns no stored config and the compiled defaults when unset', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.autoFreeConfig.get()).resolves.toEqual({
      config: null,
      defaults: { models: [...autoFreeModels] },
    });
  });

  it('stores, updates, and clears the config without touching routing config', async () => {
    await db.insert(ai_gateway_config).values({ config: { vercel_routing_percentage: 10 } });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.autoFreeConfig.set({ config });
    expect((await caller.admin.autoFreeConfig.get()).config).toEqual(config);

    const updated: AutoFreeConfig = { models: [config.models[1]] };
    await caller.admin.autoFreeConfig.set({ config: updated });
    expect((await caller.admin.autoFreeConfig.get()).config).toEqual(updated);

    await caller.admin.autoFreeConfig.set({ config: null });
    expect((await caller.admin.autoFreeConfig.get()).config).toBeNull();

    const [row] = await db.select().from(ai_gateway_config);
    expect(row.config).toEqual({ vercel_routing_percentage: 10 });
  });

  it('creates the singleton row when none exists', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.autoFreeConfig.set({ config });

    const rows = await db.select().from(ai_gateway_config);
    expect(rows).toEqual([{ id: 1, config: {}, auto_free: config }]);
  });

  it('rejects invalid config', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.autoFreeConfig.set({
        config: { models: [{ ...config.models[0], weight: 0 }] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
