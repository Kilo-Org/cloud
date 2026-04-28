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

let owner: User;
let member: User;
let testOrganization: Organization;
let orgWithSettings: Organization;
let orgWithModelDenyList: Organization;
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

    testOrganization = await createTestOrganization('No Settings', owner.id, 0, {}, false);

    orgWithSettings = await createTestOrganization(
      'Org With Settings',
      owner.id,
      0,
      {
        model_deny_list: ['claude-3'],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai'],
      },
      false
    );

    orgWithModelDenyList = await createTestOrganization(
      'Model Deny List',
      owner.id,
      0,
      { model_deny_list: ['gpt-3.5-turbo'] },
      false
    );

    await addUserToOrganization(testOrganization.id, member.id, 'member');
    await addUserToOrganization(orgWithSettings.id, member.id, 'member');
    await addUserToOrganization(orgWithModelDenyList.id, member.id, 'member');
  });

  afterAll(async () => {
    for (const organization of [testOrganization, orgWithSettings, orgWithModelDenyList]) {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  describe('updateAllowLists procedure', () => {
    it('should update provider allow list and model deny list for organization owner', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        model_deny_list: ['gpt-4', 'gpt-3.5-turbo', 'claude-3'],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai', 'anthropic'],
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(result.settings.provider_policy_mode).toBe('allow');
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(updatedOrg?.settings?.provider_policy_mode).toBe('allow');
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });

    it('should clear default_model if it is in the new model_deny_list', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        default_model: 'openai/gpt-4o',
        model_deny_list: [],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai'],
      });

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithSettings.id,
        model_deny_list: ['openai/gpt-4o'],
      });

      expect(result.settings.default_model).toBeUndefined();

      const updatedOrg = await getOrganizationById(orgWithSettings.id);
      expect(updatedOrg?.settings?.default_model).toBeUndefined();
    });

    it('should clear default_model if its provider is removed from provider_allow_list', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        default_model: 'openai/gpt-4o',
        model_deny_list: [],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai'],
      });
      mockedGetProviderSlugsForModel.mockResolvedValue(new Set(['openai']));

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithSettings.id,
        provider_policy_mode: 'allow',
        provider_allow_list: ['anthropic'],
      });

      expect(result.settings.default_model).toBeUndefined();
    });

    it('should not clear default_model if it is not denied and provider remains allowed', async () => {
      const caller = await createCallerForUser(owner.id);

      const orgWithDefault = await createTestOrganization(
        'Org With Default Model',
        owner.id,
        0,
        {
          default_model: 'openai/gpt-4o',
          model_deny_list: [],
          provider_policy_mode: 'allow',
          provider_allow_list: ['openai'],
        },
        false
      );

      mockedGetProviderSlugsForModel.mockResolvedValue(new Set(['openai']));

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithDefault.id,
        model_deny_list: ['anthropic/claude-3-opus'],
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
          model_deny_list: ['gpt-4'],
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: testOrganization.id,
          model_deny_list: ['gpt-4'],
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: 'invalid-uuid',
          model_deny_list: ['gpt-4'],
        })
      ).rejects.toThrow();
    });

    it('should update partial settings', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(testOrganization.id, {
        model_deny_list: ['gpt-4', 'gpt-3.5-turbo'],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai'],
      });

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai', 'anthropic'],
      });

      expect(result.settings.provider_policy_mode).toBe('allow');
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });

    it('should deduplicate model_deny_list and provider_allow_list entries', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        model_deny_list: ['gpt-4', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4', 'claude-3'],
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai', 'openai', 'anthropic', 'openai'],
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
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

    it('should exclude models in model_deny_list for enterprise orgs', async () => {
      const openRouterModelsResponse = {
        data: [
          makeOpenRouterModel('openai/gpt-4o'),
          makeOpenRouterModel('openai/gpt-4o:free'),
          makeOpenRouterModel('anthropic/claude-3-opus'),
        ],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      const orgWithDenyList = await createTestOrganization(
        'Model Deny List',
        owner.id,
        0,
        { model_deny_list: ['openai/gpt-4o'] },
        false
      );
      await addUserToOrganization(orgWithDenyList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithDenyList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['anthropic/claude-3-opus']);
    });

    it('should include new models from allowed providers when they are not denied', async () => {
      const openRouterModelsResponse = {
        data: [makeOpenRouterModel('openai/gpt-4o'), makeOpenRouterModel('openai/gpt-4.2')],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);
      mockedGetProviderSlugsForModel.mockResolvedValue(new Set(['openai']));

      const orgWithProviderAllowList = await createTestOrganization(
        'Provider Allow List',
        owner.id,
        0,
        {
          provider_policy_mode: 'allow',
          provider_allow_list: ['openai'],
        },
        false
      );
      await addUserToOrganization(orgWithProviderAllowList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithProviderAllowList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o', 'openai/gpt-4.2']);
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
        {
          provider_policy_mode: 'allow',
          provider_allow_list: ['openai'],
        },
        false
      );
      await addUserToOrganization(orgWithProviderAllowList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithProviderAllowList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o']);
    });

    it('should ignore stale provider_allow_list before provider policy marker is set', async () => {
      const openRouterModelsResponse = {
        data: [makeOpenRouterModel('openai/gpt-4o'), makeOpenRouterModel('baidu/ernie')],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      const orgWithStaleAllowList = await createTestOrganization(
        'Provider Allow List',
        owner.id,
        0,
        { provider_allow_list: ['openai'] },
        false
      );
      await addUserToOrganization(orgWithStaleAllowList.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: orgWithStaleAllowList.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o', 'baidu/ernie']);
    });

    it('should return all models for a non-enterprise org even if access settings are set', async () => {
      const openRouterModelsResponse = {
        data: [
          makeOpenRouterModel('openai/gpt-4o'),
          makeOpenRouterModel('anthropic/claude-3-opus'),
        ],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      const teamsOrg = await createTestOrganization(
        'Teams Org With Policy',
        owner.id,
        0,
        { model_deny_list: ['openai/gpt-4o'], provider_allow_list: ['anthropic'] },
        true
      );
      await addUserToOrganization(teamsOrg.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: teamsOrg.id,
      });

      expect(result.data.map(model => model.id)).toEqual([
        'openai/gpt-4o',
        'anthropic/claude-3-opus',
      ]);
    });
  });

  describe('updateDefaultModel procedure', () => {
    it('should update default model when it is not denied', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        model_deny_list: ['claude-3'],
      });

      const result = await caller.organizations.settings.updateDefaultModel({
        organizationId: orgWithSettings.id,
        default_model: 'gpt-4',
      });

      expect(result.settings.default_model).toBe('gpt-4');

      const updatedOrg = await getOrganizationById(orgWithSettings.id);
      expect(updatedOrg?.settings?.default_model).toBe('gpt-4');
    });

    it('should reject default_model if it is in the deny list', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateDefaultModel({
          organizationId: orgWithModelDenyList.id,
          default_model: 'gpt-3.5-turbo',
        })
      ).rejects.toThrow(
        "Default model 'gpt-3.5-turbo' is not in the organization's allowed models list"
      );
    });

    it('should allow any model when no access policy is configured', async () => {
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

      await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: false,
      });

      expect(result.settings.minimum_balance).toBeUndefined();
      expect(result.settings.minimum_balance_alert_email).toBeUndefined();

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

      await updateOrganizationSettings(testOrganization.id, {
        model_deny_list: ['gpt-4'],
        data_collection: 'allow',
      });

      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: true,
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4']);
      expect(result.settings.data_collection).toBe('allow');
      expect(result.settings.minimum_balance).toBe(100);
      expect(result.settings.minimum_balance_alert_email).toEqual(['alert@example.com']);
    });

    it('should preserve other settings when disabling minimum balance alert', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(testOrganization.id, {
        model_deny_list: ['gpt-4'],
        data_collection: 'allow',
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      const result = await caller.organizations.settings.updateMinimumBalanceAlert({
        organizationId: testOrganization.id,
        enabled: false,
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4']);
      expect(result.settings.data_collection).toBe('allow');
      expect(result.settings.minimum_balance).toBeUndefined();
      expect(result.settings.minimum_balance_alert_email).toBeUndefined();
    });
  });
});
