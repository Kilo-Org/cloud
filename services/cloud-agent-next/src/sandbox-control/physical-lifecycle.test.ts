import { describe, expect, it } from 'vitest';
import {
  beginStop,
  claimCreate,
  confirmRunning,
  confirmStopped,
  exhaustStopRetries,
  fail,
  initialPhysicalRecord,
  observe,
  recordStopAttempt,
  WORKTREE_CREDENTIAL_CONTAINMENT,
  type PhysicalRecord,
} from './physical-lifecycle.js';

const NOW = 1_000;
const INTENT_ID = 'intent_1';
const PROVIDER_REF = 'ref_1';
const CONTAINMENT_CASES = [
  { name: 'legacy flags', containment: { kilocode: true, github: false } },
  { name: 'worktree scope', containment: WORKTREE_CREDENTIAL_CONTAINMENT },
];

function stopped(resumable = true): PhysicalRecord {
  return initialPhysicalRecord(resumable);
}

function creating(overrides: Partial<PhysicalRecord> = {}): PhysicalRecord {
  return {
    ...claimCreate(stopped(), INTENT_ID, NOW),
    ...overrides,
  };
}

function running(): PhysicalRecord {
  return confirmRunning(creating(), PROVIDER_REF, NOW);
}

describe('physical sandbox lifecycle', () => {
  it('starts stopped with no handles', () => {
    expect(stopped(false)).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: false,
    });
  });

  it('claimCreate from stopped persists intent with no providerRef', () => {
    const record = claimCreate(stopped(), INTENT_ID, NOW);
    expect(record.state).toBe('creating');
    expect(record.providerRef).toBeNull();
    expect(record.createIntent).toEqual({ intentId: INTENT_ID, createdAt: NOW });
    expect(record.stopTombstone).toBeNull();
  });

  it.each(CONTAINMENT_CASES)(
    'claimCreate records only requested containment $name in the creation intent',
    ({ containment }) => {
      const record = claimCreate(stopped(), INTENT_ID, NOW, undefined, containment);
      expect(record.createIntent).toStrictEqual({
        intentId: INTENT_ID,
        createdAt: NOW,
        containment,
      });
      expect(record.containment).toBeUndefined();
    }
  );

  it('claimCreate from non-stopped throws', () => {
    expect(() => claimCreate(creating(), INTENT_ID, NOW)).toThrow('claimCreate from creating');
    expect(() => claimCreate(running(), INTENT_ID, NOW)).toThrow('claimCreate from running');
    expect(() => claimCreate(fail(running(), NOW), INTENT_ID, NOW)).toThrow(
      'claimCreate from failed'
    );
  });

  it('confirmRunning retains the allocation intent until physical death', () => {
    const record = confirmRunning(creating(), PROVIDER_REF, NOW);
    expect(record.state).toBe('running');
    expect(record.providerRef).toBe(PROVIDER_REF);
    expect(record.createIntent).toEqual({ intentId: INTENT_ID, createdAt: NOW });
    expect(record.containment).toBeUndefined();
  });

  it.each(CONTAINMENT_CASES)(
    'confirmRunning atomically binds containment $name to the exact provider reference',
    ({ containment }) => {
      const record = confirmRunning(
        claimCreate(stopped(), INTENT_ID, NOW, undefined, containment),
        PROVIDER_REF,
        NOW
      );
      expect(record.createIntent).toStrictEqual({
        intentId: INTENT_ID,
        createdAt: NOW,
        containment,
      });
      expect(record.containment).toStrictEqual({ ...containment, providerRef: PROVIDER_REF });
      expect(confirmRunning(record, PROVIDER_REF, NOW)).toBe(record);
    }
  );

  it.each(CONTAINMENT_CASES)(
    'active observation promotes containment $name to the observed provider reference',
    ({ containment }) => {
      const record = observe(
        {
          ...claimCreate(stopped(), INTENT_ID, NOW, undefined, containment),
          providerRef: PROVIDER_REF,
        },
        'active'
      );
      expect(record).toMatchObject({
        state: 'running',
        providerRef: PROVIDER_REF,
      });
      expect(record.createIntent).toStrictEqual({
        intentId: INTENT_ID,
        createdAt: NOW,
        containment,
      });
      expect(record.containment).toStrictEqual({ ...containment, providerRef: PROVIDER_REF });
    }
  );

  it('beginStop from creating with no ref still writes a tombstone', () => {
    const record = beginStop(creating(), 'idle', NOW);
    expect(record.state).toBe('stopping');
    expect(record.providerRef).toBeNull();
    expect(record.createIntent).toEqual({ intentId: INTENT_ID, createdAt: NOW });
    expect(record.stopTombstone).toEqual({ reason: 'idle', attempts: 0, createdAt: NOW });
  });

  it('confirmStopped clears ref only after terminal', () => {
    const withRef = running();
    expect(withRef.providerRef).toBe(PROVIDER_REF);
    expect(fail(withRef, NOW).providerRef).toBe(PROVIDER_REF);
    expect(observe(withRef, 'unknown').providerRef).toBe(PROVIDER_REF);

    const stopping = beginStop(withRef, 'idle', NOW);
    expect(stopping.providerRef).toBe(PROVIDER_REF);
    expect(confirmStopped(stopping)).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });

  it.each(CONTAINMENT_CASES)(
    'retains bound containment $name through failed and unknown states until stopped',
    ({ containment }) => {
      const contained = confirmRunning(
        claimCreate(stopped(), INTENT_ID, NOW, undefined, containment),
        PROVIDER_REF,
        NOW
      );
      const marker = { ...containment, providerRef: PROVIDER_REF };
      expect(fail(contained, NOW).containment).toStrictEqual(marker);
      const unknown = observe(contained, 'unknown');
      expect(unknown.containment).toStrictEqual(marker);
      expect(observe(unknown, 'active').containment).toStrictEqual(marker);
      const stopping = beginStop(contained, 'idle', NOW);
      expect(exhaustStopRetries(stopping).containment).toStrictEqual(marker);
      expect(confirmStopped(stopping).containment).toBeUndefined();
      expect(observe(fail(contained, NOW), 'terminal').containment).toBeUndefined();
      expect(confirmStopped(unknown).containment).toBeUndefined();
    }
  );

  it.each(CONTAINMENT_CASES)(
    'preserves creation containment $name through failure and unknown observation',
    ({ containment }) => {
      const claimed = {
        ...claimCreate(stopped(), INTENT_ID, NOW, undefined, containment),
        providerRef: PROVIDER_REF,
      };
      const failed = fail(claimed, NOW);
      expect(failed.createIntent).toStrictEqual(claimed.createIntent);
      const unknown = observe(failed, 'unknown');
      expect(unknown.createIntent).toStrictEqual(claimed.createIntent);
      expect(observe(unknown, 'active')).toStrictEqual(unknown);
      expect(unknown.containment).toBeUndefined();
      expect(unknown.stopTombstone).toStrictEqual(failed.stopTombstone);
      expect(confirmStopped(unknown)).toStrictEqual(stopped());
    }
  );

  it('observe unknown never goes to stopped', () => {
    expect(observe(creating(), 'unknown').state).toBe('creating');
    expect(observe(running(), 'unknown').state).toBe('unknown');
    expect(observe(beginStop(running(), 'idle', NOW), 'unknown').state).toBe('stopping');
    expect(observe(fail(running(), NOW), 'unknown').state).toBe('unknown');
    expect(observe(observe(running(), 'unknown'), 'unknown').state).toBe('unknown');
  });

  it('failed does not go to creating', () => {
    const failed = fail(running(), NOW);
    expect(failed.state).toBe('failed');
    expect(() => claimCreate(failed, INTENT_ID, NOW)).toThrow('claimCreate from failed');
    expect(observe(failed, 'active').state).toBe('unknown');
    expect(observe(failed, 'unknown').state).toBe('unknown');
    expect(observe(failed, 'terminal').state).toBe('stopped');
  });

  it('confirmStopped from failed clears the ref so create can run', () => {
    const failed = fail(running(), NOW);
    expect(confirmStopped(failed)).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });

  it('failed + terminal → stopped', () => {
    const record = observe(fail(running(), NOW), 'terminal');
    expect(record).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });

  it('failed + unknown → unknown, handles retained', () => {
    const failed = fail(running(), NOW);
    const record = observe(failed, 'unknown');
    expect(record.state).toBe('unknown');
    expect(record.providerRef).toBe(PROVIDER_REF);
    expect(record.createIntent).toEqual({ intentId: INTENT_ID, createdAt: NOW });
  });

  it('exhaustStopRetries → unknown with tombstone retained', () => {
    const stopping = recordStopAttempt(beginStop(running(), 'idle', NOW));
    const record = exhaustStopRetries(stopping);
    expect(record.state).toBe('unknown');
    expect(record.stopTombstone).toEqual({ reason: 'idle', attempts: 1, createdAt: NOW });
    expect(record.providerRef).toBe(PROVIDER_REF);
  });

  it('observe(terminal) on creating with no ref → stopped, intent cleared', () => {
    const record = observe(creating(), 'terminal');
    expect(record).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });
});
