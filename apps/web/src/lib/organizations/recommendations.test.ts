import { buildRecommendations, type RecommendationState } from './recommendations';

const organizationId = '00000000-0000-4000-8000-000000000001';

// Defaults represent a well-configured organization: nothing should be recommended.
function buildState(overrides: Partial<RecommendationState> = {}): RecommendationState {
  return {
    codeReviewerEnabled: false,
    codeReviewMissingSecurityFocus: false,
    codeReviewGateOff: false,
    securityAgentEnabled: false,
    securitySlaDisabled: false,
    securityAutoAnalysisDisabled: false,
    brokenIntegrationPlatforms: [],
    linearConnected: false,
    linearBotEnabled: false,
    cloudAgentUsed: false,
    webhookTriggerCount: 1,
    githubLiteApp: false,
    ssoConfigured: true,
    seatCount: 0,
    memberCount: 0,
    ...overrides,
  };
}

function keys(state: RecommendationState): string[] {
  return buildRecommendations(organizationId, state).map(recommendation => recommendation.key);
}

describe('buildRecommendations', () => {
  it('returns nothing for a fully configured organization', () => {
    expect(buildRecommendations(organizationId, buildState())).toEqual([]);
  });

  it('does not emit feature tuning when the feature is not enabled', () => {
    const state = buildState({
      codeReviewerEnabled: false,
      codeReviewMissingSecurityFocus: true,
      codeReviewGateOff: true,
      securityAgentEnabled: false,
      securitySlaDisabled: true,
      securityAutoAnalysisDisabled: true,
    });
    expect(keys(state)).toEqual([]);
  });

  it('emits code reviewer tuning only when it is enabled', () => {
    const state = buildState({
      codeReviewerEnabled: true,
      codeReviewMissingSecurityFocus: true,
      codeReviewGateOff: true,
    });
    expect(keys(state)).toEqual([
      'code-reviewer-security-focus-missing',
      'code-reviewer-no-merge-gate',
    ]);
  });

  it('suppresses the merge gate suggestion on the read-only GitHub app and surfaces the app upgrade instead', () => {
    const state = buildState({
      codeReviewerEnabled: true,
      codeReviewGateOff: true,
      githubLiteApp: true,
    });
    const result = keys(state);
    expect(result).toContain('org-github-lite-app');
    expect(result).not.toContain('code-reviewer-no-merge-gate');
  });

  it('flags a broken integration as an attention-level reconnect', () => {
    const [recommendation] = buildRecommendations(
      organizationId,
      buildState({ brokenIntegrationPlatforms: ['github'] })
    );
    expect(recommendation).toMatchObject({
      key: 'integration-needs-reconnect',
      title: 'Reconnect GitHub',
      severity: 'attention',
    });
  });

  it('summarizes multiple broken integrations in one reconnect item', () => {
    const [recommendation] = buildRecommendations(
      organizationId,
      buildState({ brokenIntegrationPlatforms: ['github', 'slack'] })
    );
    expect(recommendation.title).toBe('Reconnect integrations');
  });

  it('recommends enabling the Linear bot only when Linear is connected but the bot is off', () => {
    expect(keys(buildState({ linearConnected: true, linearBotEnabled: false }))).toContain(
      'linear-bot-disabled'
    );
    expect(keys(buildState({ linearConnected: true, linearBotEnabled: true }))).not.toContain(
      'linear-bot-disabled'
    );
  });

  it('recommends Cloud Agent automation only when it is used and has no triggers', () => {
    expect(keys(buildState({ cloudAgentUsed: true, webhookTriggerCount: 0 }))).toContain(
      'cloud-agent-no-automation'
    );
    expect(keys(buildState({ cloudAgentUsed: false, webhookTriggerCount: 0 }))).not.toContain(
      'cloud-agent-no-automation'
    );
  });

  it('emits organization-level recommendations for SSO and unused seats', () => {
    expect(keys(buildState({ ssoConfigured: false }))).toContain('org-sso-not-configured');
    expect(keys(buildState({ seatCount: 5, memberCount: 2 }))).toContain('org-unused-seats');
    expect(keys(buildState({ seatCount: 2, memberCount: 2 }))).not.toContain('org-unused-seats');
  });

  it('orders attention items ahead of suggestions', () => {
    const result = keys(
      buildState({ brokenIntegrationPlatforms: ['github'], ssoConfigured: false })
    );
    expect(result[0]).toBe('integration-needs-reconnect');
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
        memberCount: 1,
      })
    );
    expect(recommendations.every(r => r.actionUrl.includes(organizationId))).toBe(true);
  });
});
