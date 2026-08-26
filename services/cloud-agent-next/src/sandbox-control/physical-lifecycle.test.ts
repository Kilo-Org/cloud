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
  type PhysicalRecord,
} from './physical-lifecycle.js';

const NOW = 1_000;
const INTENT_ID = 'intent_1';
const PROVIDER_REF = 'ref_1';

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

  it('claimCreate from non-stopped throws', () => {
    expect(() => claimCreate(creating(), INTENT_ID, NOW)).toThrow('claimCreate from creating');
    expect(() => claimCreate(running(), INTENT_ID, NOW)).toThrow('claimCreate from running');
    expect(() => claimCreate(fail(running(), NOW), INTENT_ID, NOW)).toThrow(
      'claimCreate from failed'
    );
  });

  it('confirmRunning sets ref and clears intent', () => {
    const record = confirmRunning(creating(), PROVIDER_REF, NOW);
    expect(record.state).toBe('running');
    expect(record.providerRef).toBe(PROVIDER_REF);
    expect(record.createIntent).toBeNull();
  });

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

  it('observe unknown never goes to stopped', () => {
    expect(observe(creating(), 'unknown').state).toBe('creating');
    expect(observe(running(), 'unknown').state).toBe('unknown');
    expect(observe(beginStop(running(), 'idle', NOW), 'unknown').state).toBe('unknown');
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
    expect(record.createIntent).toBeNull();
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
