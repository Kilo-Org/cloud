import { describe, expect, it } from 'vitest';

import { type BotIdentity } from './index';
import { INITIAL_STATE, type OnboardingEvent, reduce } from './machine';
import {
  isProvisioningTerminal,
  shouldAdvanceFromProvisioning,
  shouldFireCompletion,
  shouldFireOnboardingEntered,
} from './selectors';

const IDENTITY: BotIdentity = {
  botName: 'KiloClaw',
  botNature: 'AI assistant',
  botVibe: 'Helpful',
  botEmoji: '🤖',
};

function run(events: OnboardingEvent[]) {
  let state = INITIAL_STATE;
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}

describe('shouldFireOnboardingEntered', () => {
  it('is true when state is loaded, eligible, no pre-existing instance', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: true,
      hasAccessWithInstance: false,
    });
    expect(shouldFireOnboardingEntered(s)).toBe(true);
  });

  it('is false before onboarding-state-loaded', () => {
    expect(shouldFireOnboardingEntered(INITIAL_STATE)).toBe(false);
  });

  it('is false for users who already have access with an instance', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: true,
      hasAccessWithInstance: true,
    });
    expect(shouldFireOnboardingEntered(s)).toBe(false);
  });

  it('is false for ineligible users', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: false,
      hasAccessWithInstance: false,
    });
    expect(shouldFireOnboardingEntered(s)).toBe(false);
  });

  it('flips to false after onboarding-entered-emitted ack (fire-once)', () => {
    const loaded = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: true,
      hasAccessWithInstance: false,
    });
    expect(shouldFireOnboardingEntered(loaded)).toBe(true);
    const acked = reduce(loaded, { type: 'onboarding-entered-emitted' });
    expect(shouldFireOnboardingEntered(acked)).toBe(false);
  });
});

describe('shouldFireCompletion', () => {
  function readyState() {
    return run([
      {
        type: 'onboarding-state-loaded',
        eligible: true,
        hasAccessWithInstance: false,
      },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'instance-status-changed', status: 'running' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: true,
        status: 200,
        nowMs: 0,
      },
    ]);
  }

  it('is true once provision, instance, and gateway all signal ready', () => {
    expect(shouldFireCompletion(readyState())).toBe(true);
  });

  it('is false when gateway is ready but not settled', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'instance-status-changed', status: 'running' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: false,
        status: 200,
        nowMs: 0,
      },
    ]);
    expect(shouldFireCompletion(s)).toBe(false);
  });

  it('is false when instance is not running', () => {
    const s = run([
      {
        type: 'onboarding-state-loaded',
        eligible: true,
        hasAccessWithInstance: false,
      },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'instance-status-changed', status: 'starting' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: true,
        status: 200,
        nowMs: 0,
      },
    ]);
    expect(shouldFireCompletion(s)).toBe(false);
  });

  it('flips to false after completion-reached-emitted ack (fire-once)', () => {
    const ready = readyState();
    expect(shouldFireCompletion(ready)).toBe(true);
    const acked = reduce(ready, { type: 'completion-reached-emitted' });
    expect(shouldFireCompletion(acked)).toBe(false);
  });

  it('re-opens after retry-requested so a recovery can emit again', () => {
    const acked = reduce(readyState(), { type: 'completion-reached-emitted' });
    expect(shouldFireCompletion(acked)).toBe(false);
    const retried = reduce(acked, { type: 'retry-requested' });
    const done = run([
      {
        type: 'onboarding-state-loaded',
        eligible: true,
        hasAccessWithInstance: false,
      },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'instance-status-changed', status: 'running' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: true,
        status: 200,
        nowMs: 0,
      },
      { type: 'completion-reached-emitted' },
      { type: 'retry-requested' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'channels-skipped' },
    ]);
    expect(retried.completionReachedFired).toBe(false);
    expect(shouldFireCompletion(done)).toBe(true);
  });
});

describe('shouldAdvanceFromProvisioning', () => {
  it('is false when the instance is still starting', () => {
    const s = run([
      { type: 'instance-status-changed', status: 'starting' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: true,
        status: 200,
        nowMs: 0,
      },
    ]);
    expect(shouldAdvanceFromProvisioning(s)).toBe(false);
  });

  it('is false when gateway is ready but not settled', () => {
    const s = run([
      { type: 'instance-status-changed', status: 'running' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: false,
        status: 200,
        nowMs: 0,
      },
    ]);
    expect(shouldAdvanceFromProvisioning(s)).toBe(false);
  });

  it('is true when instance is running and gateway is ready + settled', () => {
    const s = run([
      { type: 'instance-status-changed', status: 'running' },
      {
        type: 'gateway-readiness-changed',
        ready: true,
        settled: true,
        status: 200,
        nowMs: 0,
      },
    ]);
    expect(shouldAdvanceFromProvisioning(s)).toBe(true);
  });
});

describe('isProvisioningTerminal', () => {
  it('is true once gateway502Expired has flipped', () => {
    const s = run([
      {
        type: 'gateway-readiness-changed',
        ready: false,
        settled: false,
        status: 502,
        nowMs: 0,
      },
      { type: 'gateway-grace-elapsed' },
    ]);
    expect(isProvisioningTerminal(s)).toBe(true);
  });

  it('is false during the grace window', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 0,
    });
    expect(isProvisioningTerminal(s)).toBe(false);
  });
});
