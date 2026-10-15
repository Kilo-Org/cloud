import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { vercel_model_id_overrides, type User } from '@kilocode/db/schema';
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

    const { items } = await caller.admin.vercelModelIdOverrides.list();
    expect(items).toEqual([
      {
        openrouter_model_id: 'example/unmapped-model',
        vercel_model_id: 'example/unmapped-model-1.0',
        builtin_vercel_model_id: 'example/unmapped-model',
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
      {
        openrouter_model_id: 'qwen/qwen3-32b',
        vercel_model_id: 'alibaba/qwen-3-32b-custom',
        builtin_vercel_model_id: 'alibaba/qwen-3-32b',
        updated_at: expect.any(String),
      },
    ]);
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

    const rows = await db.select().from(vercel_model_id_overrides);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-1.0',
    });
  });

  it('trims model IDs', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: '  meta/muse-wonder ',
      vercel_model_id: ' meta/muse-wonder-1.0  ',
    });

    const rows = await db.select().from(vercel_model_id_overrides);
    expect(rows).toMatchObject([
      { openrouter_model_id: 'meta/muse-wonder', vercel_model_id: 'meta/muse-wonder-1.0' },
    ]);
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
      expect(await db.select().from(vercel_model_id_overrides)).toEqual([]);
    }
  );

  it('deletes an override', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.vercelModelIdOverrides.upsert({
      openrouter_model_id: 'meta/muse-wonder',
      vercel_model_id: 'meta/muse-wonder-1.0',
    });

    await expect(
      caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'meta/muse-wonder' })
    ).resolves.toEqual({ success: true });
    expect(await db.select().from(vercel_model_id_overrides)).toEqual([]);
  });

  it('returns NOT_FOUND when deleting a missing override', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.vercelModelIdOverrides.delete({ openrouter_model_id: 'meta/muse-wonder' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
