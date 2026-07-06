jest.mock('@/lib/ai-gateway/providers/openrouter', () => {
  return {
    getEnhancedOpenRouterModels: jest.fn(),
  };
});

jest.mock('@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server', () => {
  return {
    getProviderSlugsForModel: jest.fn(),
  };
});

import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { kilocode_users, user_model_preferences } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import type { User } from '@kilocode/db/schema';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';

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
