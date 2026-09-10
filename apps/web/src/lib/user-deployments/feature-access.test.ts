import { shouldShowDeployFeature } from './feature-access';

describe('shouldShowDeployFeature', () => {
  it('shows deploy in development even without the flag or existing deployments', () => {
    expect(
      shouldShowDeployFeature({
        isDevelopment: true,
        isFlagEnabled: false,
        hasExistingDeployments: false,
      })
    ).toBe(true);
  });

  it('shows deploy when the feature flag is enabled', () => {
    expect(
      shouldShowDeployFeature({
        isDevelopment: false,
        isFlagEnabled: true,
        hasExistingDeployments: false,
      })
    ).toBe(true);
  });

  it('shows deploy for owners who already have deployments', () => {
    expect(
      shouldShowDeployFeature({
        isDevelopment: false,
        isFlagEnabled: false,
        hasExistingDeployments: true,
      })
    ).toBe(true);
  });

  it('hides deploy for other users while flags are loading', () => {
    expect(
      shouldShowDeployFeature({
        isDevelopment: false,
        isFlagEnabled: undefined,
        hasExistingDeployments: undefined,
      })
    ).toBe(false);
  });
});
