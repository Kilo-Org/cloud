import { buildFeatureAdoptionChecks } from './feature-adoption';

const organizationId = '00000000-0000-4000-8000-000000000001';

function buildState(
  overrides: Partial<Parameters<typeof buildFeatureAdoptionChecks>[1]> = {}
): Parameters<typeof buildFeatureAdoptionChecks>[1] {
  return {
    sourceControlConnected: false,
    codeReviewerEnabled: false,
    securityAgentEnabled: false,
    hasActiveCloudAgentWebhook: false,
    teamIntegrationConnected: false,
    ...overrides,
  };
}

describe('buildFeatureAdoptionChecks', () => {
  it('returns every fixed check as not adopted when no features are configured', () => {
    const checks = buildFeatureAdoptionChecks(organizationId, buildState());

    expect(checks.map(check => check.key)).toEqual([
      'source-control-integration',
      'code-reviewer',
      'security-agent',
      'cloud-agent-webhook',
      'team-integration',
    ]);
    expect(checks.every(check => !check.adopted)).toBe(true);
  });

  it('maps shared adoption state to every fixed check', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        sourceControlConnected: true,
        codeReviewerEnabled: true,
        securityAgentEnabled: true,
        hasActiveCloudAgentWebhook: true,
        teamIntegrationConnected: true,
      })
    );

    expect(checks.every(check => check.adopted)).toBe(true);
  });

  it('keeps individual checks independent', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        sourceControlConnected: true,
        securityAgentEnabled: true,
      })
    );

    expect(checks.find(check => check.key === 'source-control-integration')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'security-agent')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'code-reviewer')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'cloud-agent-webhook')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'team-integration')?.adopted).toBe(false);
  });

  it('returns organization-scoped actions', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({ hasActiveCloudAgentWebhook: true })
    );

    expect(checks.every(check => check.actionUrl.includes(organizationId))).toBe(true);
    expect(checks.find(check => check.key === 'cloud-agent-webhook')?.actionUrl).toBe(
      `/organizations/${organizationId}/cloud/triggers`
    );
  });
});
