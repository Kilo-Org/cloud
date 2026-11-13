import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { validateMaintenanceSettings } from './watch-pr-maintenance-authorization';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: { query: {} } }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-test-secret',
}));
jest.mock('@kilocode/worker-utils/kilo-token-policy', () => ({ signModernKiloToken: jest.fn() }));
jest.mock('@kilocode/worker-utils/runtime-authorization', () => ({
  createRuntimeAuthorization: jest.fn(),
  sealRuntimeAuthorization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({ resolveOrganizationMemberModelDecision: jest.fn() })
);
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/balance', () => ({ getBalanceForUser: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceForOrganizationUser: jest.fn(),
}));

const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
const input = {
  userId: 'oauth/example',
  organizationId: null,
  repoUrl: 'https://github.com/example/widgets',
  policy,
};
beforeEach(() => jest.clearAllMocks());

it.each([null, {}, { error: 'catalog unavailable' }])(
  'returns a retryable error for a non-array model catalog: %j',
  async data => {
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValueOnce({ data } as never);
    await expect(validateMaintenanceSettings(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  }
);

it('treats a missing cached model as retryable and accepts it after catalog recovery', async () => {
  jest.mocked(getEnhancedOpenRouterModels).mockResolvedValueOnce({ data: [] } as never);
  await expect(validateMaintenanceSettings(input)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  });
  jest
    .mocked(getEnhancedOpenRouterModels)
    .mockResolvedValueOnce({ data: [{ id: policy.model }] } as never);
  await expect(validateMaintenanceSettings(input)).resolves.toEqual({
    profile: null,
    environment: null,
  });
});

it('treats transient missing variant metadata as retryable rather than a permanent consent failure', async () => {
  jest
    .mocked(getEnhancedOpenRouterModels)
    .mockResolvedValueOnce({ data: [{ id: policy.model, opencode: { variants: {} } }] } as never);
  await expect(
    validateMaintenanceSettings({ ...input, policy: { ...policy, variant: 'high' } })
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
});

it('still rejects a confirmed organization policy denial', async () => {
  jest
    .mocked(getEnhancedOpenRouterModels)
    .mockResolvedValueOnce({ data: [{ id: policy.model }] } as never);
  jest
    .mocked(resolveOrganizationMemberModelDecision)
    .mockResolvedValueOnce({ decision: { allowed: false } } as never);
  await expect(
    validateMaintenanceSettings({
      ...input,
      organizationId: '10000000-0000-4000-8000-000000000001',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
