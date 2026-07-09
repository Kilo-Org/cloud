import { shouldShowCustomerSourcePrompt } from './CustomerSourcePrompt';

describe('shouldShowCustomerSourcePrompt', () => {
  it('shows for a user without a saved source on app pages', () => {
    expect(shouldShowCustomerSourcePrompt(null, '/profile')).toBe(true);
  });

  it('does not show after a user answers or dismisses the prompt', () => {
    expect(shouldShowCustomerSourcePrompt('GitHub', '/profile')).toBe(false);
    expect(shouldShowCustomerSourcePrompt('', '/profile')).toBe(false);
    expect(shouldShowCustomerSourcePrompt(undefined, '/profile')).toBe(false);
  });

  it('does not show during product setup flows', () => {
    expect(shouldShowCustomerSourcePrompt(null, '/gastown/onboarding')).toBe(false);
    expect(
      shouldShowCustomerSourcePrompt(
        null,
        '/organizations/2dce8b38-32dc-4b71-b0ec-0e3d646cbdc4/welcome'
      )
    ).toBe(false);
  });
});
