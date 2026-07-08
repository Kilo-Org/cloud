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
import {
  type User,
  type Organization,
  organization_audit_logs,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/lib/drizzle';

jest.mock('@/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => true),
}));

jest.mock('@/lib/ai-gateway/providers/openrouter', () => {
  return {
    getEnhancedOpenRouterModels: jest.fn(),
    buildAutoModelCatalogEntry: jest.fn(model => ({
      id: model.id,
      name: model.name,
      created: 0,
      description: model.description,
      architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'test' },
      top_provider: { is_moderated: false },
      pricing: { prompt: '0', completion: '0' },
      context_length: 8192,
    })),
  };
});

jest.mock('@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server', () => {
  return {
    getProviderSlugsForModel: jest.fn(),
  };
});

jest.mock('@/lib/ai-gateway/experiments/membership', () => ({
  isPublicIdExperimented: jest.fn(async () => false),
}));

import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getProviderSlugsForModel } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';

function makeTestOpenRouterModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: { input_modalities: [], output_modalities: [], tokenizer: 'test' },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 8192,
  };
}

let owner: User;
let member: User;
let billingManager: User;
let testOrganization: Organization;
let orgWithSettings: Organization;
let orgWithModelDenyList: Organization;
const mockedGetEnhancedOpenRouterModels =
  getEnhancedOpenRouterModels as unknown as jest.MockedFunction<typeof getEnhancedOpenRouterModels>;
const mockedGetProviderSlugsForModel = getProviderSlugsForModel as unknown as jest.MockedFunction<
  typeof getProviderSlugsForModel
>;
const mockedIsPublicIdExperimented = isPublicIdExperimented as unknown as jest.MockedFunction<
  typeof isPublicIdExperimented
>;

describe('organizations settings trpc router', () => {
  beforeEach(() => {
    mockedGetProviderSlugsForModel.mockReset();
    mockedGetEnhancedOpenRouterModels.mockReset();
    mockedIsPublicIdExperimented.mockReset();
    mockedIsPublicIdExperimented.mockResolvedValue(false);
    mockedGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [
        makeTestOpenRouterModel('gpt-4'),
        makeTestOpenRouterModel('gpt-3.5-turbo'),
        makeTestOpenRouterModel('openai/gpt-4o'),
        makeTestOpenRouterModel('kilo-auto/balanced'),
        makeTestOpenRouterModel('kilo-auto/frontier'),
      ],
    } satisfies OpenRouterModelsResponse);
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

    billingManager = await insertTestUser({
      google_user_email: 'billing-settings@example.com',
      google_user_name: 'Billing Settings User',
      is_admin: false,
    });

    testOrganization = await createTestOrganization('No Settings', owner.id, 0, {}, false);

    orgWithSettings = await createTestOrganization(
      'Org With Settings',
      owner.id,
      0,
      {
        model_deny_list: ['claude-3'],
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
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
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
        provider_allow_list: ['openai', 'anthropic'],
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(result.settings.provider_allow_list).toEqual(['openai', 'anthropic']);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.model_deny_list).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-3']);
      expect(updatedOrg?.settings?.provider_allow_list).toEqual(['openai', 'anthropic']);
    });

    it('should clear default_model if it is in the new model_deny_list', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(orgWithSettings.id, {
        default_model: 'openai/gpt-4o',
        model_deny_list: [],
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
        provider_allow_list: ['openai'],
      });
      mockedGetProviderSlugsForModel.mockResolvedValue(new Set(['openai']));

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: orgWithSettings.id,
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

    it('rejects billing managers changing model policy', async () => {
      const caller = await createCallerForUser(billingManager.id);

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
        provider_allow_list: ['openai'],
      });

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: testOrganization.id,
        provider_allow_list: ['openai', 'anthropic'],
      });

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

    it('should include Organization Auto only for enabled enterprise organizations', async () => {
      const openRouterModelsResponse = {
        data: [makeOpenRouterModel('openai/gpt-4o')],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);
      const organization = await createTestOrganization(
        'Organization Auto Catalog',
        owner.id,
        0,
        {
          default_model: 'kilo-auto/org',
          org_auto_model: {
            routes: {},
            fallback_model: 'kilo-auto/balanced',
          },
        },
        false
      );
      await addUserToOrganization(organization.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: organization.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o', 'kilo-auto/org']);
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

    it('should exclude data-collection-required models for teams orgs that deny collection', async () => {
      const openRouterModelsResponse = {
        data: [
          makeOpenRouterModel('openai/gpt-4o'),
          {
            ...makeOpenRouterModel('openai/gpt-4o:free'),
            mayTrainOnYourPrompts: true,
          },
        ],
      } satisfies OpenRouterModelsResponse;

      mockedGetEnhancedOpenRouterModels.mockResolvedValue(openRouterModelsResponse);

      const teamsOrg = await createTestOrganization(
        'Teams Org Denying Data Collection',
        owner.id,
        0,
        { data_collection: 'deny' },
        true
      );
      await addUserToOrganization(teamsOrg.id, member.id, 'member');

      const caller = await createCallerForUser(member.id);
      const result = await caller.organizations.settings.listAvailableModels({
        organizationId: teamsOrg.id,
      });

      expect(result.data.map(model => model.id)).toEqual(['openai/gpt-4o']);
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

    it('preserves an exact catalog variant when setting the default model', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization('Variant Default Org', owner.id, 0, {}, false);
      mockedGetEnhancedOpenRouterModels.mockResolvedValue({
        data: [
          makeTestOpenRouterModel('openai/gpt-4o'),
          makeTestOpenRouterModel('openai/gpt-4o:free'),
        ],
      } satisfies OpenRouterModelsResponse);

      const result = await caller.organizations.settings.updateDefaultModel({
        organizationId: freshOrg.id,
        default_model: 'openai/gpt-4o:free',
      });

      expect(result.settings.default_model).toBe('openai/gpt-4o:free');
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

  describe('Organization Auto procedures', () => {
    it('enables Organization Auto and preserves its default route settings', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: testOrganization.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });

      expect(result.settings.default_model).toBe('kilo-auto/org');
      expect(result.settings.org_auto_model).toEqual({
        routes: {},
        fallback_model: 'kilo-auto/balanced',
      });
    });

    it('resets an active Organization Auto default to the global default', async () => {
      const caller = await createCallerForUser(owner.id);
      const autoOrg = await createTestOrganization('Active Auto Org', owner.id, 0, {}, false);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: autoOrg.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: autoOrg.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });

      const result = await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: autoOrg.id,
        behavior: 'global',
      });

      expect(result.settings.default_model).toBeUndefined();
      expect(result.settings.org_auto_model).toEqual({
        routes: { code: 'kilo-auto/frontier' },
        fallback_model: 'kilo-auto/balanced',
      });
      const auditLogs = await db.query.organization_audit_logs.findMany({
        where: eq(organization_audit_logs.organization_id, autoOrg.id),
      });
      expect(auditLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message:
              'Disabled Organization Auto and reset organization default model to global default.',
          }),
        ])
      );
    });

    it('rejects auto tiers when the organization has an active model policy', async () => {
      const caller = await createCallerForUser(owner.id);
      const restrictedOrg = await createTestOrganization(
        'Restricted Auto Org',
        owner.id,
        0,
        { provider_allow_list: ['openai'] },
        false
      );

      await expect(
        caller.organizations.settings.setOrganizationAutoRoute({
          organizationId: restrictedOrg.id,
          mode_slug: 'code',
          model_id: 'kilo-auto/balanced',
        })
      ).rejects.toThrow(
        'cannot use an auto tier while the organization has an active model policy'
      );

      await expect(
        caller.organizations.settings.configureOrganizationDefaultBehavior({
          organizationId: restrictedOrg.id,
          behavior: 'auto',
          fallback_model: 'kilo-auto/balanced',
        })
      ).rejects.toThrow(
        'cannot use an auto tier while the organization has an active model policy'
      );
    });

    it('does not create audit logs for no-op default behavior saves', async () => {
      const caller = await createCallerForUser(owner.id);
      const noOpOrg = await createTestOrganization('No-op Auto Org', owner.id, 0, {}, false);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: noOpOrg.id,
        behavior: 'global',
      });
      let auditLogs = await db.query.organization_audit_logs.findMany({
        where: eq(organization_audit_logs.organization_id, noOpOrg.id),
      });
      expect(auditLogs).toHaveLength(0);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: noOpOrg.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });
      auditLogs = await db.query.organization_audit_logs.findMany({
        where: eq(organization_audit_logs.organization_id, noOpOrg.id),
      });
      expect(auditLogs).toHaveLength(1);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: noOpOrg.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });
      auditLogs = await db.query.organization_audit_logs.findMany({
        where: eq(organization_audit_logs.organization_id, noOpOrg.id),
      });
      expect(auditLogs).toHaveLength(1);
    });

    it('validates stored routes before enabling Organization Auto', async () => {
      const caller = await createCallerForUser(owner.id);
      const autoOrg = await createTestOrganization(
        'Invalid Auto Route Org',
        owner.id,
        0,
        {
          default_model: 'gpt-4',
          org_auto_model: {
            routes: { code: 'custom-llm/stale-model' },
            fallback_model: 'kilo-auto/balanced',
          },
        },
        false
      );

      await expect(
        caller.organizations.settings.configureOrganizationDefaultBehavior({
          organizationId: autoOrg.id,
          behavior: 'auto',
          fallback_model: 'kilo-auto/balanced',
        })
      ).rejects.toThrow('Cannot enable Organization Auto because route "code" is invalid');
    });

    it('preserves non-auto specific default semantics when configuring a specific model', async () => {
      const caller = await createCallerForUser(owner.id);
      const specificOrg = await createTestOrganization(
        'Specific Default Org',
        owner.id,
        0,
        {},
        false
      );

      const result = await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: specificOrg.id,
        behavior: 'specific',
        specific_model: 'any-model',
      });

      expect(result.settings.default_model).toBe('any-model');
    });

    it('sets and clears Organization Auto routes', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });

      let updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings.org_auto_model?.routes.code).toBe('kilo-auto/frontier');

      await caller.organizations.settings.clearOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'code',
      });

      updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings.org_auto_model?.routes.code).toBeUndefined();
    });

    it('requires a specific model when replacing Organization Auto', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: testOrganization.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });

      await expect(
        caller.organizations.settings.configureOrganizationDefaultBehavior({
          organizationId: testOrganization.id,
          behavior: 'specific',
        })
      ).rejects.toThrow('Specific model is required.');

      const result = await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: testOrganization.id,
        behavior: 'specific',
        specific_model: 'kilo-auto/balanced',
      });

      expect(result.settings.default_model).toBe('kilo-auto/balanced');
      expect(result.settings.org_auto_model).toEqual({
        routes: {},
        fallback_model: 'kilo-auto/balanced',
      });
    });

    it('does not allow updateDefaultModel to clear an active Organization Auto default', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: testOrganization.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });

      await expect(
        caller.organizations.settings.updateDefaultModel({
          organizationId: testOrganization.id,
          default_model: null,
        })
      ).rejects.toThrow('Configure Organization Auto through the default model behavior flow.');
    });

    it('preserves Organization Auto routes when unrelated settings change', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: testOrganization.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });
      await caller.organizations.settings.updateDataCollection({
        organizationId: testOrganization.id,
        dataCollection: 'deny',
      });

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings.org_auto_model?.routes.code).toBe('kilo-auto/frontier');
      expect(updatedOrg?.settings.data_collection).toBe('deny');
    });

    it('rejects model policy changes that would invalidate active Organization Auto', async () => {
      const caller = await createCallerForUser(owner.id);
      const autoOrg = await createTestOrganization(
        'Invalidated Auto Policy Org',
        owner.id,
        0,
        {},
        false
      );

      await caller.organizations.settings.configureOrganizationDefaultBehavior({
        organizationId: autoOrg.id,
        behavior: 'auto',
        fallback_model: 'kilo-auto/balanced',
      });

      await expect(
        caller.organizations.settings.updateAllowLists({
          organizationId: autoOrg.id,
          provider_allow_list: ['anthropic'],
        })
      ).rejects.toThrow('active Organization Auto fallback is invalid');

      const updatedOrg = await getOrganizationById(autoOrg.id);
      expect(updatedOrg?.settings.default_model).toBe('kilo-auto/org');
      expect(updatedOrg?.settings.provider_allow_list).toBeUndefined();
    });

    it('keeps Organization Auto enabled when policy changes preserve concrete targets', async () => {
      const caller = await createCallerForUser(owner.id);
      const autoOrg = await createTestOrganization(
        'Valid Auto Policy Org',
        owner.id,
        0,
        {
          default_model: 'kilo-auto/org',
          org_auto_model: {
            routes: {},
            fallback_model: 'openai/gpt-4o',
          },
        },
        false
      );
      mockedGetProviderSlugsForModel.mockImplementation(async modelId =>
        modelId === 'openai/gpt-4o' ? new Set(['openai']) : new Set()
      );

      const result = await caller.organizations.settings.updateAllowLists({
        organizationId: autoOrg.id,
        provider_allow_list: ['openai'],
      });

      expect(result.settings.default_model).toBe('kilo-auto/org');
      expect(result.settings.org_auto_model?.fallback_model).toBe('openai/gpt-4o');
      expect(result.settings.provider_allow_list).toEqual(['openai']);
    });

    it('rejects active model experiment public IDs as Organization Auto targets', async () => {
      const caller = await createCallerForUser(owner.id);
      mockedIsPublicIdExperimented.mockImplementation(async modelId => modelId === 'openai/gpt-4o');

      await expect(
        caller.organizations.settings.setOrganizationAutoRoute({
          organizationId: testOrganization.id,
          mode_slug: 'code',
          model_id: 'openai/gpt-4o',
        })
      ).rejects.toThrow('cannot use an active model experiment');
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

  describe('updateRecommendationsDigest procedure', () => {
    afterEach(async () => {
      // Reset settings between cases so each starts from a clean slate.
      await updateOrganizationSettings(testOrganization.id, {});
    });

    it('should enable the recommendations digest (enterprise org)', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.settings.updateRecommendationsDigest({
        organizationId: testOrganization.id,
        enabled: true,
      });

      expect(result.settings.recommendations_digest_enabled).toBe(true);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.recommendations_digest_enabled).toBe(true);
    });

    it('should disable the digest and persist the explicit opt-out', async () => {
      const caller = await createCallerForUser(owner.id);

      await caller.organizations.settings.updateRecommendationsDigest({
        organizationId: testOrganization.id,
        enabled: true,
      });

      const result = await caller.organizations.settings.updateRecommendationsDigest({
        organizationId: testOrganization.id,
        enabled: false,
      });

      expect(result.settings.recommendations_digest_enabled).toBe(false);

      const updatedOrg = await getOrganizationById(testOrganization.id);
      expect(updatedOrg?.settings?.recommendations_digest_enabled).toBe(false);
    });

    it('should throw UNAUTHORIZED error for non-owner users', async () => {
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.organizations.settings.updateRecommendationsDigest({
          organizationId: testOrganization.id,
          enabled: true,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should throw FORBIDDEN for non-enterprise organizations', async () => {
      const teamsOrg = await createTestOrganization('Teams Org Digest', owner.id, 0, {}, true);

      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.settings.updateRecommendationsDigest({
          organizationId: teamsOrg.id,
          enabled: true,
        })
      ).rejects.toThrow('The recommendations digest is not available for this organization.');

      await db.delete(organizations).where(eq(organizations.id, teamsOrg.id));
    });

    it('should preserve other settings when toggling the digest', async () => {
      const caller = await createCallerForUser(owner.id);

      await updateOrganizationSettings(testOrganization.id, {
        model_deny_list: ['gpt-4'],
        minimum_balance: 100,
        minimum_balance_alert_email: ['alert@example.com'],
      });

      const result = await caller.organizations.settings.updateRecommendationsDigest({
        organizationId: testOrganization.id,
        enabled: true,
      });

      expect(result.settings.model_deny_list).toEqual(['gpt-4']);
      expect(result.settings.minimum_balance).toBe(100);
      expect(result.settings.minimum_balance_alert_email).toEqual(['alert@example.com']);
      expect(result.settings.recommendations_digest_enabled).toBe(true);
    });
  });
});
