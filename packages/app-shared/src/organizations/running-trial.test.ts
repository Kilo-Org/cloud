import { describe, expect, it } from 'vitest';

import { isRunningTrialStage, RUNNING_TRIAL_STAGES } from './running-trial';

describe('isRunningTrialStage', () => {
  it('accepts the four stages a trial is still running in', () => {
    expect(isRunningTrialStage('trial_active')).toBe(true);
    expect(isRunningTrialStage('trial_ending_soon')).toBe(true);
    expect(isRunningTrialStage('trial_ending_very_soon')).toBe(true);
    expect(isRunningTrialStage('trial_expires_today')).toBe(true);
  });

  it('rejects the expired stages and a bypassed trial', () => {
    expect(isRunningTrialStage('trial_expired_soft')).toBe(false);
    expect(isRunningTrialStage('trial_expired_hard')).toBe(false);
    expect(isRunningTrialStage('subscribed')).toBe(false);
    expect(isRunningTrialStage(null)).toBe(false);
    expect(isRunningTrialStage(undefined)).toBe(false);
  });

  it('keeps the stage set disjoint from the past and the bypass', () => {
    // A stage that slips into both sets would make a lapsed trial read as
    // running, so the members stay a strict subset of the entitlement union.
    const stages = Object.keys(RUNNING_TRIAL_STAGES);
    expect(stages).toHaveLength(4);
    for (const stage of stages) {
      expect(stage.startsWith('trial_expired')).toBe(false);
      expect(stage).not.toBe('subscribed');
    }
  });
});
