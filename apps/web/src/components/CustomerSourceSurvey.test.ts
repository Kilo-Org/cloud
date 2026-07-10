import { shouldShowCustomerSourceSurvey } from './CustomerSourceSurvey';

describe('shouldShowCustomerSourceSurvey', () => {
  it('shows for a user without a saved source on app pages', () => {
    expect(shouldShowCustomerSourceSurvey(null, '/profile')).toBe(true);
  });

  it('does not show after a user answers or dismisses the survey', () => {
    expect(shouldShowCustomerSourceSurvey('GitHub', '/profile')).toBe(false);
    expect(shouldShowCustomerSourceSurvey('', '/profile')).toBe(false);
    expect(shouldShowCustomerSourceSurvey(undefined, '/profile')).toBe(false);
  });

  it('does not show during product setup flows', () => {
    expect(shouldShowCustomerSourceSurvey(null, '/gastown/onboarding')).toBe(false);
    expect(
      shouldShowCustomerSourceSurvey(
        null,
        '/organizations/2dce8b38-32dc-4b71-b0ec-0e3d646cbdc4/welcome'
      )
    ).toBe(false);
  });

  it('shows on routes adjacent to product setup flows', () => {
    expect(shouldShowCustomerSourceSurvey(null, '/gastown/onboarding-complete')).toBe(true);
    expect(
      shouldShowCustomerSourceSurvey(
        null,
        '/organizations/2dce8b38-32dc-4b71-b0ec-0e3d646cbdc4/welcome-back'
      )
    ).toBe(true);
  });
});
