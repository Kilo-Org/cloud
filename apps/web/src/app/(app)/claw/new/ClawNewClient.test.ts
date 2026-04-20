import { describe, expect, test } from '@jest/globals';
import {
  getClawNewMode,
  getCreateFirstFlowFlags,
  getCreateFlowStartedAtFromMarker,
  shouldApplyCreateFlowCallback,
} from './ClawNewClient';

describe('ClawNewClient helpers', () => {
  test('re-seeds createFlowStartedAt from the onboarding marker', () => {
    expect(getCreateFlowStartedAtFromMarker(false, () => 42)).toBeNull();
    expect(getCreateFlowStartedAtFromMarker(true, () => 42)).toBe(42);
  });

  test('derives create-first mode from onboarding progress inputs', () => {
    expect(
      getClawNewMode({
        createFlowStartedAt: null,
        hasActiveInstance: true,
        onboardingInProgress: false,
      })
    ).toBe('post-provisioning');

    expect(
      getClawNewMode({
        createFlowStartedAt: 1,
        hasActiveInstance: true,
        onboardingInProgress: false,
      })
    ).toBe('create-first');

    expect(
      getClawNewMode({
        createFlowStartedAt: null,
        hasActiveInstance: false,
        onboardingInProgress: false,
      })
    ).toBe('create-first');

    expect(
      getClawNewMode({
        createFlowStartedAt: null,
        hasActiveInstance: true,
        onboardingInProgress: true,
      })
    ).toBe('create-first');
  });

  test('computes auto-start and intro-skip flags for the personal create-first flow', () => {
    expect(
      getCreateFirstFlowFlags({
        mode: 'create-first',
        autoStartFailed: false,
        onboardingInProgress: false,
        hasActiveInstance: false,
      })
    ).toEqual({
      skipCreateInstanceStep: true,
      autoProvisionOnMount: true,
    });

    expect(
      getCreateFirstFlowFlags({
        mode: 'create-first',
        autoStartFailed: true,
        onboardingInProgress: false,
        hasActiveInstance: false,
      })
    ).toEqual({
      skipCreateInstanceStep: false,
      autoProvisionOnMount: false,
    });

    expect(
      getCreateFirstFlowFlags({
        mode: 'create-first',
        autoStartFailed: false,
        onboardingInProgress: true,
        hasActiveInstance: false,
      })
    ).toEqual({
      skipCreateInstanceStep: true,
      autoProvisionOnMount: false,
    });
  });

  test('only applies create-flow callbacks for the active user', () => {
    expect(
      shouldApplyCreateFlowCallback({
        activeUserId: 'user-a',
        callbackUserId: 'user-a',
      })
    ).toBe(true);

    expect(
      shouldApplyCreateFlowCallback({
        activeUserId: 'user-b',
        callbackUserId: 'user-a',
      })
    ).toBe(false);

    expect(
      shouldApplyCreateFlowCallback({
        activeUserId: null,
        callbackUserId: 'user-a',
      })
    ).toBe(false);
  });
});
