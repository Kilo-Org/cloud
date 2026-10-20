import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';
import { AUTO_FREE_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { AI_GATEWAY_CONFIG_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';

let admin: User;
let nonAdmin: User;

const config: AutoFreeConfig = {
  models: [
    { model: 'provider/model-a:free', weight: 2, reasoning: { enabled: true, effort: 'high' } },
    { model: 'provider/model-b:free', weight: 1, reasoning: { enabled: false } },
  ],
};

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null), set: jest.fn(), del: jest.fn() },
}));

const redisSet = jest.mocked(redisClient.set);

function lastPublishedSnapshot(): unknown {
  const call = redisSet.mock.lastCall;
  expect(call?.[0]).toBe(AI_GATEWAY_CONFIG_REDIS_KEY);
  expect(call?.[2]).toEqual({ ex: 300 });
  return JSON.parse(String(call?.[1]));
}

beforeEach(async () => {
  redisSet.mockReset();
  redisSet.mockResolvedValue('OK' as never);
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
  it('accepts the fallback config', () => {
    expect(AutoFreeConfigSchema.safeParse(AUTO_FREE_FALLBACK_CONFIG).success).toBe(true);
  });

  it.each([
    'stealth/space-bunny-alpha',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'dots-studio/dots-3-note-preview:free',
    '~provider/model-latest',
  ])('accepts model ID %p', model => {
    const result = AutoFreeConfigSchema.safeParse({ models: [{ ...config.models[0], model }] });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate models', () => {
    const result = AutoFreeConfigSchema.safeParse({
      models: [config.models[0], config.models[0]],
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "x');--:free",
    "x\\'--:free",
    'provider/model :free',
    'Provider/Model:free',
    'provider/model_a:free',
    'provider@model:free',
    '',
  ])('rejects model ID %p', model => {
    const result = AutoFreeConfigSchema.safeParse({
      models: [{ ...config.models[0], model }],
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

  it('returns no stored config and the openrouter/free fallback when unset', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.autoFreeConfig.get()).resolves.toEqual({
      config: null,
      fallback: {
        models: [{ model: 'openrouter/free', weight: 1, reasoning: { enabled: true } }],
      },
    });
  });

  it('stores, updates, and clears the config without touching routing config', async () => {
    await db.insert(ai_gateway_config).values({ config: { vercel_routing_enabled: false } });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.autoFreeConfig.set({ config });
    expect((await caller.admin.autoFreeConfig.get()).config).toEqual(config);
    expect(lastPublishedSnapshot()).toEqual({
      config: { vercel_routing_enabled: false },
      auto_free: config,
      unavailable_models: null,
      preferred_models: null,
    });

    const updated: AutoFreeConfig = { models: [config.models[1]] };
    await caller.admin.autoFreeConfig.set({ config: updated });
    expect((await caller.admin.autoFreeConfig.get()).config).toEqual(updated);

    await caller.admin.autoFreeConfig.set({ config: null });
    expect((await caller.admin.autoFreeConfig.get()).config).toBeNull();
    expect(lastPublishedSnapshot()).toMatchObject({ auto_free: null });
    expect(redisSet).toHaveBeenCalledTimes(3);

    const [row] = await db.select().from(ai_gateway_config);
    expect(row.config).toEqual({ vercel_routing_enabled: false });
  });

  it('creates the singleton row when none exists', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.autoFreeConfig.set({ config });

    const rows = await db.select().from(ai_gateway_config);
    expect(rows).toEqual([
      {
        id: 1,
        config: {},
        auto_free: config,
        preferred_models: null,
        unavailable_models: null,
        vercel_model_id_overrides: null,
      },
    ]);
  });

  it('rejects invalid config', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.autoFreeConfig.set({
        config: { models: [{ ...config.models[0], weight: 0 }] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each(['provider/paid-model', 'anthropic/claude-sonnet-4:free', 'kilo-auto/free'])(
    'rejects ineligible model %s',
    async model => {
      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.autoFreeConfig.set({
          config: { models: [config.models[0], { model, weight: 1, reasoning: {} }] },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining(model) });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
      expect(redisSet).not.toHaveBeenCalled();
    }
  );
});
