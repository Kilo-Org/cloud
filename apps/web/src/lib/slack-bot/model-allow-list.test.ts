import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import { PRIMARY_DEFAULT_MODEL } from '@kilocode/web-shared/lib/ai-gateway/models';
import type { OrganizationGroupPolicies } from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import type { OrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import type * as EffectiveModelAccess from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';

jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getOrganizationById: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/preferred-models', () => ({
  getPreferredModels: jest.fn(),
}));

// Keep the real policy evaluator and decision function so the cases below use
// production deny/allow semantics. Only the two database-backed entry points are
// stubbed, plus the provider lookup, which is the documented seam that keeps the
// decision independent of the live model catalog.
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => {
  const actual = jest.requireActual<typeof EffectiveModelAccess>(
    '@kilocode/web-shared/lib/organizations/effective-model-access.server'
  );
  return {
    ...actual,
    resolveOrganizationDefaultModelPolicy: jest.fn(),
    getEffectiveModelDecision: (
      policy: Parameters<typeof actual.getEffectiveModelDecision>[0],
      modelId: string
    ) => actual.getEffectiveModelDecision(policy, modelId, async () => new Set(['test-provider'])),
  };
});

import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  evaluateEffectiveModelAccessPolicy,
  resolveOrganizationDefaultModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { getDefaultAllowedModel } from './model-allow-list';

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';
const PREFERRED_MODELS = ['test/preferred-1', 'test/preferred-2'];

function organization(settings: Record<string, unknown>, plan = 'enterprise'): Organization {
  return { id: ORGANIZATION_ID, plan, settings } as Organization;
}

function usePolicy(
  organizationSettings: Record<string, unknown>,
  defaultPolicies: OrganizationGroupPolicies,
  plan = 'enterprise'
): void {
  const context: OrganizationGroupPolicyContext = {
    organization: organization(organizationSettings, plan),
    defaultPolicies,
    groupIds: [],
    groupPolicies: [],
    policyRevision: 1,
  };
  jest
    .mocked(resolveOrganizationDefaultModelPolicy)
    .mockResolvedValue(evaluateEffectiveModelAccessPolicy(context));
}

describe('getDefaultAllowedModel', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(getOrganizationById).mockReset();
    jest.mocked(getPreferredModels).mockReset();
    jest.mocked(getPreferredModels).mockResolvedValue(PREFERRED_MODELS);
    jest.mocked(getOrganizationById).mockResolvedValue(organization({}));
  });

  it('returns null when the policy allows none of the candidates', async () => {
    usePolicy({ model_deny_list: [PRIMARY_DEFAULT_MODEL, ...PREFERRED_MODELS] }, [
      { type: 'model_access', data: { mode: 'all' } },
    ]);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBeNull();
  });

  it('returns null when the policy grants no models at all', async () => {
    usePolicy({}, [{ type: 'model_access', data: { mode: 'none' } }]);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBeNull();
  });

  it('returns a preferred model when the policy does not allow the global default', async () => {
    usePolicy({ model_deny_list: [PRIMARY_DEFAULT_MODEL] }, [
      { type: 'model_access', data: { mode: 'all' } },
    ]);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBe(PREFERRED_MODELS[0]);
  });

  it('prefers the organization default model when the policy allows it', async () => {
    jest
      .mocked(getOrganizationById)
      .mockResolvedValue(organization({ default_model: 'test/org-default' }));
    usePolicy({ default_model: 'test/org-default' }, [
      {
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['test/org-default'],
          provider_allow_list: [],
        },
      },
    ]);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBe('test/org-default');
  });

  it('returns the global default when the organization restricts nothing', async () => {
    usePolicy({}, [], 'teams');

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBe(PRIMARY_DEFAULT_MODEL);
  });

  it('returns the global default for an unknown organization', async () => {
    jest.mocked(getOrganizationById).mockResolvedValue(null);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID)).resolves.toBe(PRIMARY_DEFAULT_MODEL);
  });

  it('resolves the exempt bot default model under a policy that allows no other model', async () => {
    usePolicy({}, [{ type: 'model_access', data: { mode: 'none' } }]);

    await expect(getDefaultAllowedModel(ORGANIZATION_ID, DEFAULT_BOT_MODEL)).resolves.toBe(
      DEFAULT_BOT_MODEL
    );
  });
});
