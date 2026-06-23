import { buildFeatureAdoptionChecks } from './feature-adoption';

const organizationId = '00000000-0000-4000-8000-000000000001';

function buildState(
  overrides: Partial<Parameters<typeof buildFeatureAdoptionChecks>[1]> = {}
): Parameters<typeof buildFeatureAdoptionChecks>[1] {
  return {
    sourceControlConnected: false,
    codeReviewerEnabled: false,
    securityAgentEnabled: false,
    teamIntegrationConnected: false,
    cloudAgentUsed: false,
    projectDeployed: false,
    ...overrides,
  };
}

describe('buildFeatureAdoptionChecks', () => {
  it('returns every reliable fixed check as incomplete when no features are configured or used', () => {
    const checks = buildFeatureAdoptionChecks(organizationId, buildState());

    expect(checks.map(check => check.key)).toEqual([
      'source-control-integration',
      'code-reviewer',
      'security-agent',
      'team-integration',
      'cloud-agent-used',
      'project-deployed',
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
        teamIntegrationConnected: true,
        cloudAgentUsed: true,
        projectDeployed: true,
      })
    );

    expect(checks.every(check => check.adopted)).toBe(true);
  });

  it('uses status labels that match what each check measures', () => {
    const checks = buildFeatureAdoptionChecks(organizationId, buildState());

    expect(checks.find(check => check.key === 'source-control-integration')).toMatchObject({
      adoptedLabel: 'Connected',
      notAdoptedLabel: 'Not connected',
    });
    expect(checks.find(check => check.key === 'code-reviewer')).toMatchObject({
      adoptedLabel: 'Enabled',
      notAdoptedLabel: 'Not enabled',
    });
    expect(checks.find(check => check.key === 'cloud-agent-used')).toMatchObject({
      adoptedLabel: 'Used',
      notAdoptedLabel: 'Not used',
    });
    expect(checks.find(check => check.key === 'project-deployed')).toMatchObject({
      adoptedLabel: 'Deployed',
      notAdoptedLabel: 'Not deployed',
    });
  });

  it('keeps individual checks independent', () => {
    const checks = buildFeatureAdoptionChecks(
      organizationId,
      buildState({
        sourceControlConnected: true,
        securityAgentEnabled: true,
        cloudAgentUsed: true,
      })
    );

    expect(checks.find(check => check.key === 'source-control-integration')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'security-agent')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'cloud-agent-used')?.adopted).toBe(true);
    expect(checks.find(check => check.key === 'code-reviewer')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'team-integration')?.adopted).toBe(false);
    expect(checks.find(check => check.key === 'project-deployed')?.adopted).toBe(false);
  });

  it('returns organization-scoped actions', () => {
    const checks = buildFeatureAdoptionChecks(organizationId, buildState());

    expect(checks.every(check => check.actionUrl.includes(organizationId))).toBe(true);
  });
});
