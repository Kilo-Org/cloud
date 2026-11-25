import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
} from '../../shared/control-plane-timers.js';
import { nextTransportRecovery, parseTransportRecovery } from './transport-recovery.js';

const timers = CONTROL_PLANE_TIMERS.session;
const since = 1_000_000;
const SECOND = 1_000;

describe('nextTransportRecovery', () => {
  it('runs passes 15 s, 30 s and 60 s apart, each ending at the 2 s pass deadline', () => {
    const first = nextTransportRecovery(since, since, timers);
    expect(first).toEqual({ since, dueAt: since + 15 * SECOND });

    const second = nextTransportRecovery(since, since + 17 * SECOND, timers);
    expect(second).toEqual({ since, dueAt: since + 47 * SECOND });

    const third = nextTransportRecovery(since, since + 49 * SECOND, timers);
    expect(third).toEqual({ since, dueAt: since + 109 * SECOND });
  });

  it('gives up at the first unanswered pass at least 90 s after the window started', () => {
    expect(nextTransportRecovery(since, since + 89_999, timers)).not.toBeNull();
    expect(nextTransportRecovery(since, since + 90 * SECOND, timers)).toBeNull();
    expect(nextTransportRecovery(since, since + 111 * SECOND, timers)).toBeNull();
  });

  it('scales the delays and the window with the development divisor', () => {
    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' }).session;
    expect(nextTransportRecovery(since, since, scaled)?.dueAt).toBe(since + 1_500);
    // The 2 s pass deadline stays real, so the scaled passes end later in their window.
    expect(nextTransportRecovery(since, since + 3_500, scaled)?.dueAt).toBe(since + 6_500);
    expect(nextTransportRecovery(since, since + 8_500, scaled)?.dueAt).toBe(since + 14_500);
    expect(nextTransportRecovery(since, since + 16_500, scaled)).toBeNull();
  });
});

describe('parseTransportRecovery', () => {
  it('reads the stored due time and window start', () => {
    expect(parseTransportRecovery({ dueAt: 20, since: 5 }, timers)).toEqual({
      dueAt: 20,
      since: 5,
    });
  });

  it('reads a bare due time from a deploy before the window as one consumed delay', () => {
    expect(parseTransportRecovery(since, timers)).toEqual({
      dueAt: since,
      since: since - timers.transportRecoveryMs,
    });
  });

  it.each([undefined, null, 'soon', -1, 1.5, { dueAt: 20 }, { dueAt: 20, since: 5, extra: 1 }])(
    'treats %j as no obligation',
    raw => {
      expect(parseTransportRecovery(raw, timers)).toBeNull();
    }
  );
});
