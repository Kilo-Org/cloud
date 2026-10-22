import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import {
  VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT,
  VercelModelIdOverridesConfigSchema,
} from '@kilocode/db/schema-types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

async function storedOverrides() {
  const [row] = await db
    .select({ config: ai_gateway_config.vercel_model_id_overrides })
    .from(ai_gateway_config);
  return row?.config ?? null;
}

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `vercel-model-id-overrides-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `vercel-model-id-overrides-user-${Math.random()}@example.com`,
  });
});

describe('VercelModelIdOverridesConfigSchema', () => {
  it('rejects duplicate OpenRouter model IDs', () => {
    const override = { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/a' };
    expect(
      VercelModelIdOverridesConfigSchema.safeParse({ overrides: [override, override] }).success
    ).toBe(false);
  });

  it('rejects more than the maximum number of overrides', () => {
    const overrides = Array.from({ length: VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT + 1 }, (_, i) => ({
      openrouter_model_id: `provider/model-${i}`,
      vercel_model_id: `provider/model-${i}`,
    }));
    expect(VercelModelIdOverridesConfigSchema.safeParse({ overrides }).success).toBe(false);
  });
});

describe('adminVercelModelIdOverridesRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.vercelModelIdOverrides.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.admin.vercelModelIdOverrides.upsert({
        openrouter_model_id: 'meta/muse-wonder',
        vercel_model_id: 'meta/muse-wonder-1.0',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'meta/muse-wonder' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns no overrides when none are stored', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.vercelModelIdOverrides.list()).resolves.toEqual({ items: [] });
  });

  it('lists overrides sorted by OpenRouter model ID with the built-in mapping', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'qwen/qwen3-32b',
      vercel_model_id: 'alibaba/qwen-3-32b-custom',
    });
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'example/unmapped-model',
      vercel_model_id: 'example/unmapped-model-1.0',
    });

    await expect(caller.admin.vercelModelIdOverrides.list()).resolves.toEqual({
      items: [
        {
          openrouter_model_id: 'example/unmapped-model',
          vercel_model_id: 'example/unmapped-model-1.0',
          builtin_vercel_model_id: 'example/unmapped-model',
        },
        {
          openrouter_model_id: 'qwen/qwen3-32b',
          vercel_model_id: 'alibaba/qwen-3-32b-custom',
          builtin_vercel_model_id: 'alibaba/qwen3-32b',
        },
      ],
    });
  });

  it('stores overrides in ai_gateway_config without touching other gateway config', async () => {
    const preferredModels = { models: ['provider/model-a'] };
    await db.insert(ai_gateway_config).values({
      config: { vercel_routing_opt_out_models: ['provider/model-x'] },
      preferred_models: preferredModels,
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-1.0',
    });

    const [row] = await db.select().from(ai_gateway_config);
    expect(row).toMatchObject({
      config: { vercel_routing_opt_out_models: ['provider/model-x'] },
      preferred_models: preferredModels,
      vercel_model_id_overrides: {
        overrides: [
          { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/muse-wonder-1.0' },
        ],
      },
    });
  });

  it('updates an existing override in place', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-0.9',
    });
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-1.0',
    });

    expect(await storedOverrides()).toEqual({
      overrides: [
        { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/muse-wonder-1.0' },
      ],
    });
  });

  it('trims model IDs', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: '  meta/muse-wonder ',
      vercel_model_id: ' meta/muse-wonder-1.0  ',
    });

    expect(await storedOverrides()).toEqual({
      overrides: [
        { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/muse-wonder-1.0' },
      ],
    });
  });

  it.each(['', 'Meta/Muse-Wonder', 'meta/muse wonder'])(
    'rejects invalid model ID %p without writing',
    async modelId => {
      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.vercelModelIdOverrides.upsert({
          openrouter_model_id: modelId,
          vercel_model_id: 'meta/muse-wonder-1.0',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.admin.vercelModelIdOverrides.upsert({
          openrouter_model_id: 'meta/muse-wonder',
          vercel_model_id: modelId,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    }
  );

  it('rejects a new override beyond the maximum without writing', async () => {
    const overrides = Array.from({ length: VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT }, (_, i) => ({
      openrouter_model_id: `provider/model-${i}`,
      vercel_model_id: `provider/model-${i}`,
    }));
    await db.insert(ai_gateway_config).values({ vercel_model_id_overrides: { overrides } });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.vercelModelIdOverrides.upsert({
        openrouter_model_id: 'provider/one-too-many',
        vercel_model_id: 'provider/one-too-many',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await storedOverrides())?.overrides).toHaveLength(VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT);
  });

  it('deletes an override and clears the column when none remain', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-1.0',
    });
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'qwen/qwen3-32b',
      vercel_model_id: 'alibaba/qwen-3-32b-custom',
    });

    await expect(
      caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'meta/muse-wonder' })
    ).resolves.toEqual({ success: true });
    expect(await storedOverrides()).toEqual({
      overrides: [
        { openrouter_model_id: 'qwen/qwen3-32b', vercel_model_id: 'alibaba/qwen-3-32b-custom' },
      ],
    });

    await caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'qwen/qwen3-32b' });
    expect(await storedOverrides()).toBeNull();
  });

  it('returns NOT_FOUND when deleting a missing override', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'meta/muse-wonder' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
