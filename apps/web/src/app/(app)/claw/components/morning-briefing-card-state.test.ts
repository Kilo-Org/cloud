import { describe, expect, test } from '@jest/globals';
import { deriveMorningBriefingCardState } from './morning-briefing-card-state';

describe('deriveMorningBriefingCardState', () => {
  test('keeps warmup state when gateway_warming_up payload coexists with stale enabled=false', () => {
    const state = deriveMorningBriefingCardState({
      isRunning: true,
      actionsReady: true,
      briefingStatus: {
        code: 'gateway_warming_up',
        enabled: false,
        desiredEnabled: false,
        observedEnabled: false,
        reconcileState: 'in_progress',
      },
    });

    expect(state.isWarmupState).toBe(true);
    expect(state.isGatewayWarmupStatus).toBe(true);
  });

  test('exits warmup when actions are ready and status is resolved without warmup code', () => {
    const state = deriveMorningBriefingCardState({
      isRunning: true,
      actionsReady: true,
      briefingStatus: {
        enabled: true,
        desiredEnabled: true,
        observedEnabled: true,
        reconcileState: 'succeeded',
      },
    });

    expect(state.isWarmupState).toBe(false);
    expect(state.desiredEnabled).toBe(true);
    expect(state.observedEnabled).toBe(true);
  });
});
