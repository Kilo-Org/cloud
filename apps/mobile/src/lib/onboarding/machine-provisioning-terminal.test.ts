/**
 * Reducer coverage for the provisioning terminal signals added alongside
 * `getProvisioningTerminalReason` (query errors, the overall wall-clock
 * timeout, and their reset on retry). Split out of `machine.test.ts` to stay
 * under the file's line budget.
 */
import { describe, expect, it } from 'vitest';

import { INITIAL_STATE, type OnboardingEvent, reduce } from './machine';

function run(events: OnboardingEvent[]) {
  let state = INITIAL_STATE;
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}

describe('provisioning-query-errored', () => {
  it('flips queryErrored', () => {
    const s = reduce(INITIAL_STATE, { type: 'provisioning-query-errored' });
    expect(s.queryErrored).toBe(true);
  });
});

describe('provisioning-timeout-elapsed', () => {
  it('flips provisioningTimedOut', () => {
    const s = reduce(INITIAL_STATE, { type: 'provisioning-timeout-elapsed' });
    expect(s.provisioningTimedOut).toBe(true);
  });
});

describe('retry-requested clears terminal signals', () => {
  it('clears queryErrored and provisioningTimedOut', () => {
    const s = run([
      { type: 'provisioning-query-errored' },
      { type: 'provisioning-timeout-elapsed' },
      { type: 'retry-requested' },
    ]);
    expect(s.queryErrored).toBe(false);
    expect(s.provisioningTimedOut).toBe(false);
  });
});
