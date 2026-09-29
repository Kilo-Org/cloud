import { describe, expect, it } from 'vitest';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import { POLICY } from '../sandbox-state/schedule.js';
import {
  composeControlAlarmAt,
  CONTROL_ALARM_ANCHORS_KEY,
  importLegacyControlAlarmAnchors,
  loadControlAlarmAnchors,
  scheduleControlAlarm,
  type AlarmScheduler,
  type ControlAlarmAnchorState,
} from './control-alarm.js';

const NOW = 1_000_000;
const CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CAPS,
};

function allocated(deadlineAt = NOW + POLICY.heartbeatExpiryMs): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'intent-1', createdAt: NOW - 1_000 },
      health: {
        kind: 'healthy',
        incarnation: 'inc-1',
        lastHeartbeat: { incarnation: 'inc-1', at: NOW, ready: true },
        deadlineAt,
      },
      idleAt: null,
    },
  };
}

function stopped(): AllocationRecord {
  return { v: 2, resumable: true, state: { kind: 'stopped', summary: null } };
}

function recordingScheduler(): AlarmScheduler & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setAlarm: async at => {
      calls.push(`set:${at}`);
    },
    deleteAlarm: async () => {
      calls.push('delete');
    },
  };
}

function anchorStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const reads: string[] = [];
  return {
    reads,
    get: async (key: string) => {
      reads.push(key);
      return values.get(key);
    },
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    value: (key: string) => values.get(key),
  };
}

describe('control alarm composition', () => {
  it('takes the earliest of the allocation, credential and socket anchors', () => {
    expect(
      composeControlAlarmAt({
        allocation: allocated(NOW + 500),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: NOW + 3_000,
      })
    ).toBe(NOW + 500);
    expect(
      composeControlAlarmAt({
        allocation: allocated(),
        credentialExpiryAt: NOW + 1_000,
        socketHandshakeAt: NOW + 3_000,
      })
    ).toBe(NOW + 1_000);
    expect(
      composeControlAlarmAt({
        allocation: allocated(),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: NOW + 200,
      })
    ).toBe(NOW + 200);
  });

  it('ignores a stopped allocation and uses only the infrastructure anchors', () => {
    expect(
      composeControlAlarmAt({
        allocation: stopped(),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: null,
      })
    ).toBe(NOW + 5_000);
  });

  it('returns null when no anchor is armed', () => {
    expect(
      composeControlAlarmAt({
        allocation: stopped(),
        credentialExpiryAt: null,
        socketHandshakeAt: null,
      })
    ).toBeNull();
  });
});

describe('control alarm scheduling', () => {
  it('sets the composed alarm through the scheduler', async () => {
    const scheduler = recordingScheduler();
    const at = await scheduleControlAlarm(scheduler, {
      allocation: allocated(NOW + 500),
      credentialExpiryAt: NOW + 5_000,
      socketHandshakeAt: null,
    });
    expect(at).toBe(NOW + 500);
    expect(scheduler.calls).toEqual([`set:${NOW + 500}`]);
  });

  it('deletes the alarm when nothing is armed', async () => {
    const scheduler = recordingScheduler();
    expect(
      await scheduleControlAlarm(scheduler, {
        allocation: null,
        credentialExpiryAt: null,
        socketHandshakeAt: null,
      })
    ).toBeNull();
    expect(scheduler.calls).toEqual(['delete']);
  });
});

describe('legacy control alarm anchor import', () => {
  it('imports future numeric anchors with their exact timestamps', async () => {
    const storage = anchorStorage({
      deadlines: { socketHandshake: NOW + 3_000, credentialExpiry: NOW + 5_000 },
    });

    await importLegacyControlAlarmAnchors(storage, NOW);

    const anchors = storage.value(CONTROL_ALARM_ANCHORS_KEY) as ControlAlarmAnchorState;
    expect(anchors).toEqual({
      socketHandshakeAt: NOW + 3_000,
      credentialExpiryAt: NOW + 5_000,
    });
    expect(composeControlAlarmAt({ allocation: null, ...anchors })).toBe(NOW + 3_000);
  });

  it.each([undefined, {}])(
    'persists the empty completion marker when the legacy value is %j',
    async legacy => {
      const storage = anchorStorage(legacy === undefined ? {} : { deadlines: legacy });

      await importLegacyControlAlarmAnchors(storage, NOW);

      expect(storage.value(CONTROL_ALARM_ANCHORS_KEY)).toEqual({
        credentialExpiryAt: null,
        socketHandshakeAt: null,
      });
    }
  );

  it('applies the unchecked future predicate to string timestamps', async () => {
    const storage = anchorStorage({
      deadlines: { socketHandshake: '4102444800000', credentialExpiry: 'not-a-number' },
    });

    await importLegacyControlAlarmAnchors(storage, NOW);

    // Raw write parity: the future numeric string passes `>` by coercion and is
    // persisted unchanged. The schema-validating loader would reject it.
    expect(storage.value(CONTROL_ALARM_ANCHORS_KEY)).toEqual({
      socketHandshakeAt: '4102444800000',
      credentialExpiryAt: null,
    });
    expect(await loadControlAlarmAnchors(storage)).toEqual({
      credentialExpiryAt: null,
      socketHandshakeAt: null,
    });
  });

  it('imports null for a past or cancelled legacy anchor', async () => {
    const storage = anchorStorage({
      deadlines: { socketHandshake: NOW - 1, credentialExpiry: NOW },
    });

    await importLegacyControlAlarmAnchors(storage, NOW);

    expect(storage.value(CONTROL_ALARM_ANCHORS_KEY)).toEqual({
      socketHandshakeAt: null,
      credentialExpiryAt: null,
    });
  });

  it('never re-reads the legacy key after completion', async () => {
    const storage = anchorStorage({ deadlines: { socketHandshake: NOW + 3_000 } });
    await importLegacyControlAlarmAnchors(storage, NOW);
    const afterFirst = storage.value(CONTROL_ALARM_ANCHORS_KEY);

    storage.reads.length = 0;
    await storage.put('deadlines', { socketHandshake: NOW + 99_000 });
    await importLegacyControlAlarmAnchors(storage, NOW);

    expect(storage.reads).toEqual([CONTROL_ALARM_ANCHORS_KEY]);
    expect(storage.value(CONTROL_ALARM_ANCHORS_KEY)).toEqual(afterFirst);
  });
});
