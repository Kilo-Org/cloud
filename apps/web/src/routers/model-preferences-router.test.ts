jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => {
  return {
    getEnhancedOpenRouterModels: jest.fn(),
  };
});

jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => {
    return {
      getProviderSlugsForModel: jest.fn(),
    };
  }
);

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'),
  isValidOpenRouterModelId: jest.fn(async () => true),
}));

import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  byok_api_keys,
  direct_byok_model_lists,
  kilocode_users,
  user_model_preferences,
} from '@kilocode/db/schema';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import type { User } from '@kilocode/db/schema';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@kilocode/web-shared/lib/organizations/organization-types';

const mockedGetEnhancedOpenRouterModels =
  getEnhancedOpenRouterModels as unknown as jest.MockedFunction<typeof getEnhancedOpenRouterModels>;

function makeOpenRouterModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: [],
      output_modalities: [],
      tokenizer: 'test',
    },
    top_provider: {
      is_moderated: false,
    },
    pricing: {
      prompt: '0',
      completion: '0',
    },
    context_length: 8192,
  };
}

let testUser: User;

describe('modelPreferences', () => {
  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'model-preferences-test@example.com',
      google_user_name: 'Model Preferences Test User',
    });
  });

  afterEach(async () => {
    await db.delete(user_model_preferences).where(eq(user_model_preferences.user_id, testUser.id));
  });

  describe('get', () => {
    it('returns empty preferences for a fresh user', async () => {
      const caller = await createCallerForUser(testUser.id);
      const result = await caller.modelPreferences.get({});
      expect(result).toEqual({ favorites: [], lastSelected: null });
    });

    it('returns persisted preferences after writes', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.setLastSelected({ model: 'anthropic/claude-3.5-sonnet' });
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });

      const result = await caller.modelPreferences.get({});
      expect(result.lastSelected).toEqual({ model: 'anthropic/claude-3.5-sonnet' });
      expect(result.favorites).toEqual(['openai/gpt-4o']);
    });
  });

  describe('setLastSelected', () => {
    it('upserts last selected model without variant', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.setLastSelected({ model: 'anthropic/claude-3.5-sonnet' });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.last_selected).toEqual({ model: 'anthropic/claude-3.5-sonnet' });
    });

    it('upserts last selected model with variant', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.setLastSelected({
        model: 'anthropic/claude-3.5-sonnet',
        variant: 'thinking',
      });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.last_selected).toEqual({
        model: 'anthropic/claude-3.5-sonnet',
        variant: 'thinking',
      });
    });

    it('clears last selected when given null', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.setLastSelected({ model: 'anthropic/claude-3.5-sonnet' });
      await caller.modelPreferences.clearLastSelected();

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.last_selected).toBeNull();
    });
  });

  describe('favorites', () => {
    it('adds a favorite', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.favorites).toEqual(['openai/gpt-4o']);
    });

    it('does not duplicate when adding the same favorite twice', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.favorites).toEqual(['openai/gpt-4o']);
    });

    it('removes a favorite', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await caller.modelPreferences.addFavorite({ model: 'anthropic/claude-3.5-sonnet' });
      await caller.modelPreferences.removeFavorite({ model: 'openai/gpt-4o' });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.favorites).toEqual(['anthropic/claude-3.5-sonnet']);
    });

    it('is a no-op when removing a favorite that is not present', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await caller.modelPreferences.removeFavorite({ model: 'anthropic/claude-3.5-sonnet' });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.favorites).toEqual(['openai/gpt-4o']);
    });

    it('does not lose favorites on concurrent adds', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await Promise.all([
        caller.modelPreferences.addFavorite({ model: 'anthropic/claude-3.5-sonnet' }),
        caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o-mini' }),
      ]);

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect([...(row?.favorites ?? [])].sort()).toEqual([
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
      ]);
    });

    it('replaces the full favorites set', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await caller.modelPreferences.addFavorite({ model: 'anthropic/claude-3.5-sonnet' });
      await caller.modelPreferences.setFavorites({ models: ['openai/gpt-4o-mini'] });

      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(row?.favorites).toEqual(['openai/gpt-4o-mini']);
    });
  });

  describe('catalog-mode BYOK keys', () => {
    const mappedOriginal = 'synthetic/hf:moonshotai/kimi-k2.6';
    const unmappedOriginal = 'synthetic/hf:example/finetune';

    beforeAll(async () => {
      // Provider model lists are cached per process; no earlier test reads this provider.
      await db
        .insert(direct_byok_model_lists)
        .values({
          provider_id: 'synthetic',
          models: [
            {
              id: 'hf:moonshotai/Kimi-K2.6',
              name: 'Kimi-K2.6',
              context_length: 262144,
              max_completion_tokens: 65535,
              catalog_model_id: 'moonshotai/kimi-k2.6',
            },
            {
              id: 'hf:example/finetune',
              name: 'Finetune',
              context_length: 262144,
              max_completion_tokens: 65535,
            },
          ],
          synced_at: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: direct_byok_model_lists.provider_id,
          set: { models: sql`excluded.models` },
        });
      await db.insert(byok_api_keys).values({
        kilo_user_id: testUser.id,
        provider_id: 'synthetic',
        encrypted_api_key: encryptApiKey('synthetic-key', BYOK_ENCRYPTION_KEY),
        serve_catalog_models: true,
        created_by: testUser.id,
      });
    });

    afterAll(async () => {
      await db.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, testUser.id));
      await db
        .delete(direct_byok_model_lists)
        .where(eq(direct_byok_model_lists.provider_id, 'synthetic'));
    });

    async function storeFavorites(favorites: string[]) {
      await db.insert(user_model_preferences).values({
        user_id: testUser.id,
        favorites,
        last_selected: { model: mappedOriginal, variant: 'high' },
      });
    }

    async function storedFavorites() {
      const row = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      return row?.favorites;
    }

    it('reads bespoke ids as catalog ids and hides unmapped ones without rewriting them', async () => {
      await storeFavorites([mappedOriginal, unmappedOriginal, 'moonshotai/kimi-k2.6']);
      const caller = await createCallerForUser(testUser.id);

      await expect(caller.modelPreferences.get({})).resolves.toEqual({
        favorites: ['moonshotai/kimi-k2.6'],
        lastSelected: { model: 'moonshotai/kimi-k2.6', variant: 'high' },
      });
      await expect(storedFavorites()).resolves.toEqual([
        mappedOriginal,
        unmappedOriginal,
        'moonshotai/kimi-k2.6',
      ]);
    });

    it('removes the stored original of a translated favorite', async () => {
      await storeFavorites([mappedOriginal, unmappedOriginal, 'openai/gpt-4o']);
      const caller = await createCallerForUser(testUser.id);

      await caller.modelPreferences.removeFavorite({ model: 'moonshotai/kimi-k2.6' });

      await expect(storedFavorites()).resolves.toEqual([unmappedOriginal, 'openai/gpt-4o']);
    });

    it('keeps stored originals when replacing favorites', async () => {
      await storeFavorites([mappedOriginal, unmappedOriginal]);
      const caller = await createCallerForUser(testUser.id);

      await caller.modelPreferences.setFavorites({
        models: ['openai/gpt-4o', 'moonshotai/kimi-k2.6'],
      });

      await expect(storedFavorites()).resolves.toEqual([
        'openai/gpt-4o',
        mappedOriginal,
        unmappedOriginal,
      ]);
    });
  });

  describe('org filtering', () => {
    it('rejects an organization the user is not a member of', async () => {
      const caller = await createCallerForUser(testUser.id);
      await expect(
        caller.modelPreferences.get({
          organizationId: '00000000-0000-0000-0000-000000000000',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('drops favorites that are not available in the given org', async () => {
      mockedGetEnhancedOpenRouterModels.mockResolvedValue({
        data: [makeOpenRouterModel('anthropic/claude-3.5-sonnet')],
      } satisfies OpenRouterModelsResponse);
      const organization = await createTestOrganization('Model Preferences Org', testUser.id, 0);

      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });
      await caller.modelPreferences.addFavorite({ model: 'anthropic/claude-3.5-sonnet' });
      await caller.modelPreferences.setLastSelected({ model: 'openai/gpt-4o' });

      const result = await caller.modelPreferences.get({ organizationId: organization.id });
      expect(result.favorites).toEqual(['anthropic/claude-3.5-sonnet']);
      expect(result.lastSelected).toBeNull();
    });
  });

  describe('cascade on user delete', () => {
    it('removes the row when the user is hard-deleted', async () => {
      const caller = await createCallerForUser(testUser.id);
      await caller.modelPreferences.addFavorite({ model: 'openai/gpt-4o' });

      const before = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(before).toBeDefined();

      await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));

      const after = await db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, testUser.id),
      });
      expect(after).toBeUndefined();
    });
  });
});
