import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  updateOrganizationSettings,
  getOrganizationById,
} from '@/lib/organizations/organizations';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import type { User, Organization } from '@kilocode/db/schema';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/lib/drizzle';

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

import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

// Test users and organizations will be created dynamically
let owner: User;
let member: User;
let testOrganization: Organization;
let orgWithSettings: Organization;
let orgWithModelAllowList: Organization;
const mockedGetEnhancedOpenRouterModels =
  getEnhancedOpenRouterModels as unknown as jest.MockedFunction<typeof getEnhancedOpenRouterModels>;
const mockedGetProviderSlugsForModel = getProviderSlugsForModel as unknown as jest.MockedFunction<
  typeof getProviderSlugsForModel
>;

describe('organizations settings trpc router', () => {
  beforeEach(() => {
    mockedGetProviderSlugsForModel.mockReset();
    mockedGetEnhancedOpenRouterModels.mockReset();
  });

  beforeAll(async () => {
    // Create test users using the helper function
    owner = await insertTestUser({
      google_user_email: 'owner-settings@example.com',
      google_user_name: 'Owner Settings User',
      is_admin: false,
    });

    member = await insertTestUser({
      google_user_email: 'member-settings@example.com',
      google_user_name: 'Member Settings User',
      is_admin: false,
    });

    // Create test organization with no settings and require_seats = false
    testOrganization = await createTestOrganization('No Settings', owner.id, 0, {}, false);

    // Create organization with some initial settings and require_seats = false
    orgWithSettings = await createTestOrganization(
      'Org With Settings',
      owner.id,
      0,
      { model_allow_list: ['gpt-4'], provider_allow_list: ['openai'] },
      false
    );

    // Create organization with model allow list for validation tests and require_seats = false
    orgWithModelAllowList = await createTestOrganization(
      'Model Allow List',
      owner.id,
      0,
      { model_allow_list: ['gpt-4'] },
      false
    );

    // Add member to all organizations
    await addUserToOrganization(testOrganization.id, member.id, 'member');
    await addUserToOrganization(orgWithSettings.id, member.id, 'member');
    await addUserToOrganization(orgWithModelAllowList.id, member.id, 'member');
  });

  afterAll(async () => {
    for (const organization of [testOrganization, orgWithSettings, orgWithModelAllowList]) {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  describe('updateAllowLists procedure', () => {
    it('should update organization allow lists for organization owner', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        model_allow_list: ['gpt-4', 'gpt-3.5-turbo', 'claude-3'],
        provider_allow_list: ['openai', 'anthropic'],
      });

      expect(result.settings.model_allow_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_allow_list).toEqual([
        'gpt-4',
        'gpt-3.5-turbo',
        'claude-3',
      ]);
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });

    it('should clear default_model if it is not in the new model_allow_list', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        default_model: 'openai/gpt-4o',
        model_allow_list: ['openai/gpt-4o', 'gpt-4'],
      });

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithSettings.id,
        model_allow_list: ['gpt-4'],
      });

      expect(result.settings.default_model).toBeUndefined();

      const updatedOrg = await getOrganizationById(orgWithSettings.id);
      expect(updatedOrg?.settings?.default_model).toBeUndefined();
    });

    it('should not clear default_model if it is in the new model_allow_list', async () => {
      const caller = await createCallerForUser(owner.id);

      const orgWithDefault = await createTestOrganization(
        'Org With Default Model',
        owner.id,
        0,
        {
          default_model: 'openai/gpt-4o',
          model_allow_list: ['openai/gpt-4o'],
        },
        false
      );

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithDefault.id,
        model_allow_list: ['openai/gpt-4o', 'anthropic/claude-3-opus'],
      });

      expect(result.settings.default_model).toBe('openai/gpt-4o');

      const updatedOrg = await getOrganizationById(orgWithDefault.id);
      expect(updatedOrg?.settings?.default_model).toBe('openai/gpt-4o');
    });

    it('should throw UNAUTHORIZED error for non-existent organization', async () => {
      const caller = await createCallerForUser(owner.id);
      const nonExistentId = randomUUID();

      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: nonExistentId,
          model_allow_list: ['gpt-4'],
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: testOrganization.id,
          model_allow_list: ['gpt-4'],
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(owner.id);

      // Test invalid UUID
      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: 'invalid-uuid',
          model_allow_list: ['gpt-4'],
        })
      ).rejects.toThrow();
    });

    it('should update partial settings', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(testOrganization.id, {
        model_allow_list: ['gpt-4', 'gpt-3.5-turbo'],
        provider_allow_list: ['openai'],
      });

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        provider_allow_list: ['openai', 'anthropic'],
      });

      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_allow_list).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });

    it('should deduplicate model_allow_list and provider_allow_list entries', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        model_allow_list: ['gpt-4', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4', 'claude-3'],
        provider_allow_list: ['openai', 'openai', 'anthropic', 'openai'],
      });

      expect(result.settings.model_allow_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_allow_list).toEqual([
        'gpt-4',
        'gpt-3.5-turbo',
        'claude-3',
      ]);
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });
  });

  describe('listAvailableModels procedure', () => {
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

    it('should exclude models absent from model_allow_list for enterprise orgs', async () => {
      const openRouterModelsResponse = {
        data: [
          makeOpenRouterModel('openai/gpt-4o'),
          makeOpenRouterModel('openai/gpt-4o:free'),
          makeOpenRouterModel('anthropic/claude-3-opus'),
        ],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      const orgWithAllowList = await createTestOrganization(
        'Model Allow List',
        owner.id,
        0,
        { model_allow_list: ['anthropic/claude-3-opus'] },
        false
      );
      await addUserToOrganization(orgWithAllowList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithAllowList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['anthropic/claude-3-opus']);
    });

    it('should exclude models only offered by providers absent from provider_allow_list', async () => {
      const openRouterModelsResponse = {
        data: [makeOpenRouterModel('openai/gpt-4o'), makeOpenRouterModel('baidu/ernie')],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);
      mockedGetProviderSlugsForModel.mockImplementation(async modelId => {
        if (modelId === 'openai/gpt-4o') return new Set(['openai']);
        if (modelId === 'baidu/ernie') return new Set(['baidu-qianfan']);
        return new Set();
      });

      const orgWithProviderAllowList = await createTestOrganization(
        'Provider Allow List',
        owner.id,
        0,
        { provider_allow_list: ['openai'] },
        false
      );
      await addUserToOrganization(orgWithProviderAllowList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithProviderAllowList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o']);
    });

    it('should return all models for a non-enterprise org even if model_allow_list is set', async () => {
      const openRouterModelsResponse = {
        data: [
          makeOpenRouterModel('openai/gpt-4o'),
          makeOpenRouterModel('anthropic/claude-3-opus'),
        ],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      // requireSeats: true sets plan to 'teams'
      const teamsOrg = await createTestOrganization(
        'Teams Org With Allow List',
        owner.id,
        0,
        { model_allow_list: ['anthropic/claude-3-opus'] },
        true
      );
      await addUserToOrganization(teamsOrg.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: teamsOrg.id,
      });

      // Teams orgs should see all models, ignoring the allow list
      expect(result.data.map(model => model.id)).toEqual([
        'openai/gpt-4o',
        'anthropic/claude-3-opus',
      ]);
    });
  });

  describe('updateDefaultModel procedure', () => {
    it('should update default model when it is allowed', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        model_allow_list: ['gpt-4'],
      });

      const result = await caller.organizations.settings.updateDefaultModel({
        organizationId: orgWithSettings.id,
        default_model: 'gpt-4',
      });

      expect(result.settings.default_model).toBe('gpt-4');

      const updatedOrg = await getOrganizationById(orgWithSettings.id);
      expect(updatedOrg?.settings?.default_model).toBe('gpt-4');
    });

    it('should reject default_model if it is absent from the allow list', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateDefaultModel({
          organizationId: orgWithModelAllowList.id,
          default_model: 'gpt-3.5-turbo',
        })
      ).rejects.toThrow(
        "Default model 'gpt-3.5-turbo' is not in the organization's allowed models list"
      );
    });

    it('should allow any model when allow list is undefined', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(testOrganization.id, {
        data_collection: 'allow',
      });

      const result = await caller.organizations.settings.updateDefaultModel({
        organizationId: testOrganization.id,
        default_model: 'any-model',
      });

      expect(result.settings.default_model).toBe('any-model');
    });

    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.settings.updateDefaultModel({
          organizationId: testOrganization.id,
          default_model: 'gpt-4',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });
  });

  describe('updateMinimumBalanceAlert procedure', () => {
    it('should enable minimum balance alert with valid settings', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      expect(result.settings.minimum_balance).toBe(100);
      expect(result.settings.minimum_balance_alert_email).toEqual(['alert@example.com']);

      // Verify from database
      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.minimum_balance).toBe(100);
      expect(updatedOrg?.settings?.minimum_balance_alert_email).toEqual(['alert@example.com']);
    });

    it('should enable minimum balance alert with multiple emails', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 50,
        minimum_balance_alert_email: ['alert1@example.com', 'alert2@example.com'],
      });

      expect(result.settings.minimum_balance).toBe(50);
      expect(result.settings.minimum_balance_alert_email).toEqual([
        'alert1@example.com',
        'alert2@example.com',
      ]);
    });

    it('should disable minimum balance alert and remove fields', async () => {
      const caller = await createCallerForUser(owner.id);

      // First enable it
      await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      // Now disable it
      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: false,
      });

      expect(result.settings.minimum_balance).toBeUndefined();
      expect(result.settings.minimum_balance_alert_email).toBeUndefined();

      // Verify from database
      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.minimum_balance).toBeUndefined();
      expect(updatedOrg?.settings?.minimum_balance_alert_email).toBeUndefined();
    });

    it('should reject when enabled is true but minimum_balance is missing', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance_alert_email: ['alert@example.com'],
        })
      ).rejects.toThrow();
    });

    it('should reject when enabled is true but minimum_balance_alert_email is missing', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: 100,
        })
      ).rejects.toThrow();
    });

    it('should reject when enabled is true but minimum_balance_alert_email is empty', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: 100,
          minimum_balance_alert_email: [],
        })
      ).rejects.toThrow();
    });

    it('should reject when minimum_balance is not positive', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: 0,
          minimum_balance_alert_email: ['alert@example.com'],
        })
      ).rejects.toThrow();

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: -10,
          minimum_balance_alert_email: ['alert@example.com'],
        })
      ).rejects.toThrow();
    });

    it('should reject invalid email addresses', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: 100,
          minimum_balance_alert_email: ['not-an-email'],
        })
      ).rejects.toThrow();
    });

    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.settings.updateMinimumBalanceAlert({
          organizationId: testOrganization.id,
          enabled: true,
          minimum_balance: 100,
          minimum_balance_alert_email: ['alert@example.com'],
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should preserve other settings when enabling minimum balance alert', async () => {
      const caller = await createCallerForUser(owner.id);

      // First set some other settings
      await updateOrganizationSettings(testOrganization.id, {
        model_allow_list: ['gpt-4'],
        data_collection: 'allow',
      });

      // Now enable minimum balance alert
      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      // Other settings should be preserved
      expect(result.settings.model_allow_list).toEqual(['gpt-4']);
      expect(result.settings.data_collection).toBe('allow');
      expect(result.settings.minimum_balance).toBe(100);
      expect(result.settings.minimum_balance_alert_email).toEqual(['alert@example.com']);
    });

    it('should preserve other settings when disabling minimum balance alert', async () => {
      const caller = await createCallerForUser(owner.id);

      // First set some settings including minimum balance
      await updateOrganizationSettings(testOrganization.id, {
        model_allow_list: ['gpt-4'],
        data_collection: 'allow',
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      // Now disable minimum balance alert
      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: false,
      });

      // Other settings should be preserved, but minimum balance fields removed
      expect(result.settings.model_allow_list).toEqual(['gpt-4']);
      expect(result.settings.data_collection).toBe('allow');
      expect(result.settings.minimum_balance).toBeUndefined();
      expect(result.settings.minimum_balance_alert_email).toBeUndefined();
    });
  });
});
