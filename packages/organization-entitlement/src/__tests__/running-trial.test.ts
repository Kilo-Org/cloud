import { describe, expect, it } from 'vitest';

import { getOrgTrialStatusFromDays, isRunningTrialStage, RUNNING_TRIAL_STAGES } from '../trial';

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

  it('classifies exactly the stages the day-boundary classifier calls running', () => {
    // One tie between the set and the classifier: every stage the day
    // boundaries produce must answer the predicate the same way the
    // classification reads, so a new stage cannot fall out of both silently.
    // `trial_expired_soft` names a trial that has lapsed — the soft window is
    // the paid grace the org may keep using, not a running trial — so only the
    // four pre-expiry stages answer true.
    for (let days = -30; days <= 30; days += 1) {
      const stage = getOrgTrialStatusFromDays(days);
      expect(isRunningTrialStage(stage)).toBe(days >= 0);
    }
    expect(Object.keys(RUNNING_TRIAL_STAGES)).toHaveLength(4);
  });
});
