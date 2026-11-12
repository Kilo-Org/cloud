import {
  buildMaintenanceEnablePolicy,
  maintenanceInheritedSettingsChanged,
  noMaintenanceConsent,
} from './pr-maintenance-enablement';

const reviewed = { profileId: '11111111-1111-4111-8111-111111111111', environmentId: null };
const draft = {
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'example/model',
  variant: null,
  trustedBotLogins: ['example-reviewer[bot]'],
  categories: { reviews: true, failedChecks: true, conflicts: true },
};

describe('maintenance enablement authorization', () => {
  it('builds only a policy for the inherited settings the user reviewed', () => {
    const reviewedWithLabels = { ...reviewed, profile: { name: 'Reviewed profile' } };
    const result = buildMaintenanceEnablePolicy(draft, reviewedWithLabels, reviewed);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.message);
    expect(result.policy.profileId).toBe(reviewed.profileId);
    expect(result.policy.environmentId).toBeNull();
    expect(result.policy.maxTotalAttempts).toBe(10);
    expect(result.policy.maxAttemptsPerProblem).toBe(2);
    expect(result.policy).not.toHaveProperty('profile');
  });

  it.each([
    { ...reviewed, profileId: '22222222-2222-4222-8222-222222222222' },
    { ...reviewed, environmentId: '33333333-3333-4333-8333-333333333333' },
  ])('never carries checked consent over changed inherited settings', current => {
    expect(maintenanceInheritedSettingsChanged(reviewed, current)).toBe(true);
    const result = buildMaintenanceEnablePolicy(draft, reviewed, current);
    expect(result).toMatchObject({
      success: false,
      message: expect.stringContaining('give consent again'),
    });
  });

  it('requires new consent after the user accepts current settings', () => {
    const current = { ...reviewed, environmentId: '33333333-3333-4333-8333-333333333333' };
    const result = buildMaintenanceEnablePolicy(
      { ...draft, ...noMaintenanceConsent },
      current,
      current
    );
    expect(result.success).toBe(false);
    expect(buildMaintenanceEnablePolicy(draft, current, current).success).toBe(true);
  });
});
