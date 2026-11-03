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
  });

  it('returns no overrides when none are stored', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.vercelModelIdOverrides.list()).resolves.toEqual({ items: [] });
  });

  it('lists overrides sorted by OpenRouter model ID with the built-in mapping', async () => {
    await db.insert(ai_gateway_config).values({
      vercel_model_id_overrides: {
        overrides: [
          { openrouter_model_id: 'qwen/qwen3-32b', vercel_model_id: 'alibaba/qwen-3-32b-custom' },
          {
            openrouter_model_id: 'example/unmapped-model',
            vercel_model_id: 'example/unmapped-model-1.0',
          },
        ],
      },
    });

    const caller = await createCallerForUser(admin.id);
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
});
