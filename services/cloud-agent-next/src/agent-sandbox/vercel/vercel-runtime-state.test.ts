import { describe, expect, it } from 'vitest';

import {
  claimVercelStopAttempt,
  classifyVercelSession,
  parseVercelCreateIntent,
  parseVercelStopTombstone,
  parseVercelWrapperLaunchIntent,
  retryVercelStopAttempt,
  type VercelCreateIntent,
  type VercelStopTombstone,
} from './vercel-runtime-state.js';

const createIntent: VercelCreateIntent = {
  version: 1,
  sandboxName: 'ses-abcdef',
  operationId: 'operation-1',
  projectId: 'project-1',
  snapshotId: 'snapshot-1',
  runtimeBuildId: 'build-1',
  runtime: 'node24',
  startedAt: 100,
  settleUntil: 500,
  attempts: 1,
  nextRetryAt: 200,
};

const stopTombstone: VercelStopTombstone = {
  version: 2,
  provider: 'vercel',
  sandboxName: 'ses-abcdef',
  sessionId: 'session-1',
  intent: { reason: 'explicit', startedAt: 100 },
  stop: { status: 'needed', attempts: 0, nextAttemptAt: 100 },
};

describe('Vercel durable runtime state', () => {
  it('validates durable create and wrapper launch intents', () => {
    expect(parseVercelCreateIntent(createIntent)).toEqual(createIntent);
    expect(
      parseVercelWrapperLaunchIntent({
        sessionId: 'session-1',
        launchId: 'launch-1',
        instanceId: 'instance-1',
        instanceGeneration: 2,
        startedAt: 100,
      })
    ).toEqual({
      sessionId: 'session-1',
      launchId: 'launch-1',
      instanceId: 'instance-1',
      instanceGeneration: 2,
      startedAt: 100,
    });
    expect(() => parseVercelCreateIntent({ ...createIntent, attempts: -1 })).toThrow();
  });

  it('parses exact-session tombstones without accepting sensitive or unknown fields', () => {
    expect(parseVercelStopTombstone(stopTombstone)).toEqual(stopTombstone);
    expect(() => parseVercelStopTombstone({ ...stopTombstone, userId: 'user-1' })).toThrow();
  });

  it('claims one due stop attempt and retries only its matching claim', () => {
    const claimed = claimVercelStopAttempt(stopTombstone, 'attempt-1', 100, 150);
    expect(claimed).toEqual({
      ...stopTombstone,
      stop: {
        status: 'stopping',
        attempts: 1,
        nextAttemptAt: 100,
        attemptId: 'attempt-1',
        attemptDeadlineAt: 150,
      },
    });
    if (!claimed) throw new Error('Expected stop claim');

    expect(claimVercelStopAttempt(claimed, 'attempt-2', 120, 170)).toBeNull();
    expect(retryVercelStopAttempt(claimed, 'stale-attempt', 200)).toBeNull();
    expect(retryVercelStopAttempt(claimed, 'attempt-1', 200)).toEqual({
      ...stopTombstone,
      stop: { status: 'needed', attempts: 1, nextAttemptAt: 200 },
    });
  });

  it('allows an expired stop claim to be reclaimed', () => {
    const claimed = claimVercelStopAttempt(stopTombstone, 'attempt-1', 100, 150);
    if (!claimed) throw new Error('Expected stop claim');

    expect(claimVercelStopAttempt(claimed, 'attempt-2', 150, 250)?.stop).toEqual({
      status: 'stopping',
      attempts: 2,
      nextAttemptAt: 100,
      attemptId: 'attempt-2',
      attemptDeadlineAt: 250,
    });
  });

  it('classifies stopped, aborted, failed, and policy-approved absence as terminal', () => {
    expect(classifyVercelSession('stopped')).toBe('terminal');
    expect(classifyVercelSession('aborted')).toBe('terminal');
    expect(classifyVercelSession('failed')).toBe('terminal');
    expect(classifyVercelSession('running')).toBe('active');
    expect(classifyVercelSession('not-found', { notFoundIsTerminal: true })).toBe('terminal');
    expect(classifyVercelSession('not-found', { notFoundIsTerminal: false })).toBe('unknown');
  });

  it('fails closed when legacy version-1 tombstones are encountered', () => {
    expect(
      parseVercelStopTombstone({
        version: 1,
        provider: 'vercel',
        sandboxName: 'ses-abcdef',
        ownershipProof: 'legacy-proof',
      })
    ).toEqual({ status: 'manual-remediation', version: 1 });
    expect(() => parseVercelStopTombstone({ version: 3, provider: 'vercel' })).toThrow();
  });
});
