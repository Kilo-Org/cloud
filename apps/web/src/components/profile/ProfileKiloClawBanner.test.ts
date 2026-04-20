import { describe, expect, test } from '@jest/globals';
import { getProfileKiloClawBannerVariant } from './ProfileKiloClawBanner';

describe('getProfileKiloClawBannerVariant', () => {
  test('shows loading while billing is loading', () => {
    expect(
      getProfileKiloClawBannerVariant({
        billingLoading: true,
        hasBilling: false,
        hasInstance: false,
        activeInstanceHasAccess: false,
        statusLoading: false,
        statusError: false,
        status: undefined,
      })
    ).toBe('loading');
  });

  test('shows continue setup when billing is active but dashboard status is null', () => {
    expect(
      getProfileKiloClawBannerVariant({
        billingLoading: false,
        hasBilling: true,
        hasInstance: true,
        activeInstanceHasAccess: true,
        statusLoading: false,
        statusError: false,
        status: null,
      })
    ).toBe('continue-setup');
  });

  test('shows active when dashboard status is populated', () => {
    expect(
      getProfileKiloClawBannerVariant({
        billingLoading: false,
        hasBilling: true,
        hasInstance: true,
        activeInstanceHasAccess: true,
        statusLoading: false,
        statusError: false,
        status: 'running',
      })
    ).toBe('active');
  });

  test('shows needs attention when instance exists without access', () => {
    expect(
      getProfileKiloClawBannerVariant({
        billingLoading: false,
        hasBilling: true,
        hasInstance: true,
        activeInstanceHasAccess: false,
        statusLoading: false,
        statusError: false,
        status: null,
      })
    ).toBe('needs-attention');
  });

  test('shows get started when no instance exists', () => {
    expect(
      getProfileKiloClawBannerVariant({
        billingLoading: false,
        hasBilling: true,
        hasInstance: false,
        activeInstanceHasAccess: false,
        statusLoading: false,
        statusError: false,
        status: null,
      })
    ).toBe('get-started');
  });
});
