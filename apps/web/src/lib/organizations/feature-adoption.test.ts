import { buildFeatureAdoptionChecks } from './feature-adoption';

const organizationId = '00000000-0000-4000-8000-000000000001';

function buildState(
  overrides: Partial<Parameters<typeof buildFeatureAdoptionChecks>[1]> = {}
): Parameters<typeof buildFeatureAdoptionChecks>[1] {
  return {
    agentConfigs: [],
    integrations: [],
    hasActiveCloudAgentWebhook: false,
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

  it('marks enabled agents and an active webhook as adopted', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        agentConfigs: [
          { agentType: 'code_review', platform: 'gitlab', isEnabled: true },
          { agentType: 'security_scan', platform: 'github', isEnabled: true },
        ],
        hasActiveCloudAgentWebhook: true,
      })
    );

    expect(checks.find(check => check.key === 'code-reviewer')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'security-agent')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'cloud-agent-webhook')?.adopted).toBe(true);
  });

  it('does not count disabled agent configurations', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        agentConfigs: [
          { agentType: 'code_review', platform: 'github', isEnabled: false },
          { agentType: 'security_scan', platform: 'github', isEnabled: false },
        ],
      })
    );

    expect(checks.find(check => check.key === 'code-reviewer')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'security-agent')?.adopted).toBe(false);
  });

  it('requires healthy active integrations', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        integrations: [
          {
            platform: 'github',
            status: 'active',
            suspendedAt: null,
            authInvalidAt: '2026-06-19T00:00:00.000Z',
          },
          {
            platform: 'slack',
            status: 'suspended',
            suspendedAt: '2026-06-19T00:00:00.000Z',
            authInvalidAt: null,
          },
          {
            platform: 'linear',
            status: 'active',
            suspendedAt: null,
            authInvalidAt: null,
          },
        ],
      })
    );

    expect(checks.find(check => check.key === 'source-control-integration')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'team-integration')?.adopted).toBe(true);
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
