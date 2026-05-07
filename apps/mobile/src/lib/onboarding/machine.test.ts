import { describe, expect, it } from 'vitest';

import { type BotIdentity } from './index';
import { GATEWAY_502_GRACE_MS, INITIAL_STATE, type OnboardingEvent, reduce } from './machine';

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

describe('INITIAL_STATE', () => {
  it('starts at identity step so cold boot never skips ahead', () => {
    expect(INITIAL_STATE.step).toBe('identity');
  });

  it('has no fire-once flags set', () => {
    expect(INITIAL_STATE.onboardingEnteredFired).toBe(false);
    expect(INITIAL_STATE.completionReachedFired).toBe(false);
  });
});

describe('onboarding-state-loaded', () => {
  it('records server-observed eligibility', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: true,
      hasAccessWithInstance: false,
    });
    expect(s.eligible).toBe(true);
    expect(s.onboardingStateLoaded).toBe(true);
  });
});

describe('start-requested', () => {
  it('clears prior errorCategory', () => {
    const loaded = reduce(INITIAL_STATE, {
      type: 'onboarding-state-loaded',
      eligible: true,
      hasAccessWithInstance: false,
    });
    const failed = reduce(loaded, { type: 'provision-failed', category: 'generic' });
    expect(failed.errorCategory).toBe('generic');
    const retried = reduce(failed, { type: 'start-requested' });
    expect(retried.errorCategory).toBeNull();
  });
});

describe('provision-succeeded', () => {
  it('captures sandboxId and resets to identity step', () => {
    const s = run([
      {
        type: 'onboarding-state-loaded',
        eligible: true,
        hasAccessWithInstance: false,
      },
      { type: 'start-requested' },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
    ]);
    expect(s.provisionStarted).toBe(true);
    expect(s.provisionSuccess).toBe(true);
    expect(s.sandboxId).toBe('sb-1');
    expect(s.step).toBe('identity');
    expect(s.errorCategory).toBeNull();
  });
});

describe('wizard step transitions', () => {
  it('walks identity -> channels -> provisioning', () => {
    const s = run([
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'channels-skipped' },
    ]);
    expect(s.step).toBe('provisioning');
    expect(s.botIdentity).toEqual(IDENTITY);
    expect(s.execPreset).toBe('never-ask');
  });

  it('stores weatherLocation from identity-submitted', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'identity-submitted',
      identity: IDENTITY,
      weatherLocation: 'Amsterdam, The Netherlands',
    });
    expect(s.weatherLocation).toBe('Amsterdam, The Netherlands');
  });

  it('defaults weatherLocation to null when omitted', () => {
    const s = reduce(INITIAL_STATE, { type: 'identity-submitted', identity: IDENTITY });
    expect(s.weatherLocation).toBeNull();
  });

  it('provisioning-complete-acknowledged advances to done', () => {
    const s = run([{ type: 'channels-skipped' }, { type: 'provisioning-complete-acknowledged' }]);
    expect(s.step).toBe('done');
  });
});

describe('step-save fire-once guards', () => {
  it('bot-identity-saved flips the botIdentitySaved flag', () => {
    const s = reduce(INITIAL_STATE, { type: 'bot-identity-saved' });
    expect(s.botIdentitySaved).toBe(true);
    expect(s.execPresetSaved).toBe(false);
  });

  it('exec-preset-saved flips the execPresetSaved flag', () => {
    const s = reduce(INITIAL_STATE, { type: 'exec-preset-saved' });
    expect(s.execPresetSaved).toBe(true);
    expect(s.botIdentitySaved).toBe(false);
  });

  it('identity-submitted clears botIdentitySaved so a re-submission re-fires', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'bot-identity-saved' },
      { type: 'step-back' },
      { type: 'identity-submitted', identity: { ...IDENTITY, botName: 'Renamed' } },
    ]);
    expect(s.botIdentitySaved).toBe(false);
    expect(s.botIdentity?.botName).toBe('Renamed');
  });
});

describe('gateway-readiness-changed', () => {
  it('records readiness and status', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: true,
      settled: true,
      status: 200,
      nowMs: 0,
    });
    expect(s.gatewayReady).toBe(true);
    expect(s.gatewaySettled).toBe(true);
    expect(s.gatewayStatus).toBe(200);
  });

  it('starts the 502 timer on first 502 observation', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 1000,
    });
    expect(s.first502AtMs).toBe(1000);
    expect(s.gateway502Expired).toBe(false);
  });

  it('preserves first502AtMs on subsequent 502s', () => {
    const a = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 1000,
    });
    const b = reduce(a, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 5000,
    });
    expect(b.first502AtMs).toBe(1000);
  });

  it('clears first502AtMs on any non-502 observation (503 included)', () => {
    const a = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 1000,
    });
    const b = reduce(a, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 503,
      nowMs: 2000,
    });
    expect(b.first502AtMs).toBeNull();
    expect(b.gateway502Expired).toBe(false);
  });

  it('flips gateway502Expired once 30s of 502s have elapsed in a single observation', () => {
    const a = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 0,
    });
    const b = reduce(a, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: GATEWAY_502_GRACE_MS,
    });
    expect(b.gateway502Expired).toBe(true);
  });
});

describe('gateway-grace-elapsed', () => {
  it('promotes to expired when a 502 is in flight', () => {
    const a = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 0,
    });
    const b = reduce(a, { type: 'gateway-grace-elapsed' });
    expect(b.gateway502Expired).toBe(true);
  });

  it('is a no-op when no 502 has been observed', () => {
    const b = reduce(INITIAL_STATE, { type: 'gateway-grace-elapsed' });
    expect(b).toBe(INITIAL_STATE);
  });
});

describe('retry-requested', () => {
  it('resets step to identity and clears step-save fire-once flags', () => {
    const s = run([
      {
        type: 'onboarding-state-loaded',
        eligible: true,
        hasAccessWithInstance: false,
      },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'channels-skipped' },
      { type: 'bot-identity-saved' },
      { type: 'exec-preset-saved' },
      { type: 'retry-requested' },
    ]);
    expect(s.step).toBe('identity');
    expect(s.botIdentitySaved).toBe(false);
    expect(s.execPresetSaved).toBe(false);
    expect(s.errorCategory).toBeNull();
  });

  it('preserves provisionSuccess and sandboxId (the instance already exists)', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'retry-requested' },
    ]);
    expect(s.provisionSuccess).toBe(true);
    expect(s.sandboxId).toBe('sb-1');
  });

  it('clears completionReachedFired so a re-run can emit the funnel event again', () => {
    const s = run([
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
    ]);
    expect(s.completionReachedFired).toBe(false);
  });

  it('clears the 502 grace sub-machine', () => {
    const s = run([
      {
        type: 'gateway-readiness-changed',
        ready: false,
        settled: false,
        status: 502,
        nowMs: 0,
      },
      { type: 'gateway-grace-elapsed' },
      { type: 'retry-requested' },
    ]);
    expect(s.first502AtMs).toBeNull();
    expect(s.gateway502Expired).toBe(false);
  });
});

describe('analytics ack events', () => {
  it('onboarding-entered-emitted flips the fire-once flag', () => {
    const s = reduce(INITIAL_STATE, { type: 'onboarding-entered-emitted' });
    expect(s.onboardingEnteredFired).toBe(true);
  });

  it('completion-reached-emitted flips the fire-once flag', () => {
    const s = reduce(INITIAL_STATE, { type: 'completion-reached-emitted' });
    expect(s.completionReachedFired).toBe(true);
  });
});
