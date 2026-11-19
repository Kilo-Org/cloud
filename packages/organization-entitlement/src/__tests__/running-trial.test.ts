import { describe, expect, it } from 'vitest';

import { getOrgTrialStatusFromDays, isRunningTrialStage, TRIAL_STAGE_RUNNING } from '../trial';
import type { OrganizationTrialStage } from '../types';

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

  it('maps every stage of the union to an answer and reads that value', () => {
    // The record spans the whole stage union, so a stage added to
    // `OrganizationTrialStage` and omitted from the record is a type error and
    // this list must name every stage. The predicate reads the mapped value,
    // so an expired stage answers false even though it has a key.
    const stages: readonly OrganizationTrialStage[] = [
      'trial_active',
      'trial_ending_soon',
      'trial_ending_very_soon',
      'trial_expires_today',
      'trial_expired_soft',
      'trial_expired_hard',
    ];
    expect(Object.keys(TRIAL_STAGE_RUNNING).sort()).toEqual([...stages].sort());

    const runningStages = stages.filter(stage => TRIAL_STAGE_RUNNING[stage]);
    expect(runningStages).toEqual([
      'trial_active',
      'trial_ending_soon',
      'trial_ending_very_soon',
      'trial_expires_today',
    ]);

    for (const stage of stages) {
      const running = stage !== 'trial_expired_soft' && stage !== 'trial_expired_hard';
      expect(TRIAL_STAGE_RUNNING[stage]).toBe(running);
      expect(isRunningTrialStage(stage)).toBe(running);
    }
  });

  it('classifies exactly the stages the day-boundary classifier calls running', () => {
    // One tie between the running subset and the classifier: every stage the
    // day boundaries produce must answer the predicate the same way the
    // classification reads. `trial_expired_soft` names a trial that has lapsed
    // — the soft window is the paid grace the org may keep using, not a
    // running trial — so only the four pre-expiry stages answer true.
    for (let days = -30; days <= 30; days += 1) {
      const stage = getOrgTrialStatusFromDays(days);
      expect(isRunningTrialStage(stage)).toBe(days >= 0);
    }
    const runningKeys = Object.entries(TRIAL_STAGE_RUNNING)
      .filter(([, running]) => running)
      .map(([stage]) => stage);
    expect(runningKeys).toHaveLength(4);
    expect(Object.keys(TRIAL_STAGE_RUNNING)).toHaveLength(6);
  });
});
