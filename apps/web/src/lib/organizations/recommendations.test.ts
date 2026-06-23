import { buildRecommendations, type RecommendationState } from './recommendations';

const organizationId = '00000000-0000-4000-8000-000000000001';

// Defaults represent a healthy organization: nothing open, no feature gaps.
function buildState(overrides: Partial<RecommendationState> = {}): RecommendationState {
  return {
    sourceControlConnected: false,
    codeReviewerEnabled: false,
    codeReviewMissingSecurityFocus: false,
    codeReviewGateApplicable: false,
    codeReviewGateOff: false,
    securityAgentEnabled: false,
    securitySlaDisabled: false,
    securityAutoAnalysisDisabled: false,
    brokenIntegrationPlatforms: [],
    linearConnected: false,
    linearBotEnabled: false,
    teamIntegrationConnected: false,
    cloudAgentUsed: false,
    projectDeployed: false,
    webhookTriggerCount: 1,
    githubConnected: false,
    githubLiteApp: false,
    ssoConfigured: true,
    seatCount: 0,
    seatsUsed: 0,
    ...overrides,
  };
}

function openKeys(state: RecommendationState): string[] {
  return buildRecommendations(organizationId, state)
    .filter(r => r.status === 'open')
    .map(r => r.key);
}

function completedKeys(state: RecommendationState): string[] {
  return buildRecommendations(organizationId, state)
    .filter(r => r.status === 'completed')
    .map(r => r.key);
}

function find(state: RecommendationState, key: string) {
  return buildRecommendations(organizationId, state).find(r => r.key === key);
}

describe('buildRecommendations', () => {
  it('reports a healthy organization as completed, not open', () => {
    const state = buildState();
    expect(openKeys(state)).toEqual([]);
    expect(completedKeys(state)).toEqual(
      expect.arrayContaining(['org-sso-not-configured', 'org-unused-seats'])
    );
  });

  it('omits a feature rule entirely when the feature is not enabled', () => {
    const state = buildState({ codeReviewerEnabled: false, codeReviewMissingSecurityFocus: true });
    expect(find(state, 'code-reviewer-security-focus-missing')).toBeUndefined();
  });

  it('marks an enabled feature with a gap as open', () => {
    const state = buildState({ codeReviewerEnabled: true, codeReviewMissingSecurityFocus: true });
    expect(find(state, 'code-reviewer-security-focus-missing')?.status).toBe('open');
  });

  it('marks an enabled feature without a gap as completed, with done-phrased copy', () => {
    const state = buildState({ codeReviewerEnabled: true, codeReviewMissingSecurityFocus: false });
    const recommendation = find(state, 'code-reviewer-security-focus-missing');
    expect(recommendation?.status).toBe('completed');
    expect(recommendation?.title).toBe('Security review focus enabled');
  });

  it('suppresses the merge gate rule when no enabled config can gate', () => {
    // GitHub-only org on the read-only app: no gate-capable config.
    const state = buildState({
      githubConnected: true,
      githubLiteApp: true,
      codeReviewerEnabled: true,
      codeReviewGateApplicable: false,
      codeReviewGateOff: false,
    });
    expect(find(state, 'code-reviewer-no-merge-gate')).toBeUndefined();
    expect(find(state, 'org-github-lite-app')?.status).toBe('open');
  });

  it('opens the merge gate rule when a gate-capable config has the gate off', () => {
    const state = buildState({
      codeReviewerEnabled: true,
      codeReviewGateApplicable: true,
      codeReviewGateOff: true,
    });
    expect(find(state, 'code-reviewer-no-merge-gate')?.status).toBe('open');
  });

  it('marks the merge gate rule completed when a gate-capable config has a gate set', () => {
    const state = buildState({
      codeReviewerEnabled: true,
      codeReviewGateApplicable: true,
      codeReviewGateOff: false,
    });
    expect(find(state, 'code-reviewer-no-merge-gate')?.status).toBe('completed');
  });

  it('treats a broken integration as an open attention item with no completed state', () => {
    const broken = buildState({ brokenIntegrationPlatforms: ['github'] });
    const recommendation = find(broken, 'integration-needs-reconnect');
    expect(recommendation?.status).toBe('open');
    expect(recommendation?.severity).toBe('attention');

    // No broken integrations means the reconnect item is absent, not completed.
    expect(find(buildState(), 'integration-needs-reconnect')).toBeUndefined();
  });

  it('flips SSO between open and completed based on configuration', () => {
    expect(find(buildState({ ssoConfigured: false }), 'org-sso-not-configured')).toMatchObject({
      status: 'open',
      title: 'Set up SSO',
    });
    expect(find(buildState({ ssoConfigured: true }), 'org-sso-not-configured')).toMatchObject({
      status: 'completed',
      title: 'SSO configured',
    });
  });

  it('opens the unused-seats rule only when seats exceed members', () => {
    expect(openKeys(buildState({ seatCount: 5, seatsUsed: 2 }))).toContain('org-unused-seats');
    expect(openKeys(buildState({ seatCount: 2, seatsUsed: 2 }))).not.toContain('org-unused-seats');
  });

  it('deep-links Security Agent recommendations to their settings tabs', () => {
    const state = buildState({
      securityAgentEnabled: true,
      securitySlaDisabled: true,
      securityAutoAnalysisDisabled: true,
    });

    expect(find(state, 'security-agent-sla-disabled')?.actionUrl).toBe(
      `/organizations/${organizationId}/security-agent/config?tab=sla`
    );
    expect(find(state, 'security-agent-auto-analysis-disabled')?.actionUrl).toBe(
      `/organizations/${organizationId}/security-agent/config?tab=automation`
    );
  });

  it('scopes every action url to the organization', () => {
    const recommendations = buildRecommendations(
      organizationId,
      buildState({
        codeReviewerEnabled: true,
        codeReviewMissingSecurityFocus: true,
        securityAgentEnabled: true,
        securitySlaDisabled: true,
        brokenIntegrationPlatforms: ['github'],
        cloudAgentUsed: true,
        webhookTriggerCount: 0,
        ssoConfigured: false,
        seatCount: 5,
        seatsUsed: 1,
      })
    );
    expect(recommendations.every(r => r.actionUrl.includes(organizationId))).toBe(true);
  });
});
