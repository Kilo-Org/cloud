import { describe, expect, it } from 'vitest';

import {
  getSessionTranscriptItemKey,
  mergeSessionTranscript,
} from '@/components/agents/session-transcript';

function message(id: string) {
  return {
    info: {
      id,
      sessionID: 'ses_12345678901234567890123456',
      role: 'user' as const,
      time: { created: 1 },
      agent: 'test',
      model: { providerID: 'test', modelID: 'test' },
    },
    parts: [],
  };
}

function attempt(id: string, triggerMessageId: string) {
  return {
    id,
    triggerMessageId,
    status: 'completed' as const,
    startedAt: 1,
    completedAt: 2,
    revision: 1,
    // A real cold-start attempt always records at least one substantive step;
    // without one a completed attempt is treated as a warm-reuse no-op and hidden.
    steps: [
      {
        id: `${id}:step`,
        key: 'cloning',
        kind: 'phase' as const,
        label: 'cloning',
        status: 'completed' as const,
        startedAt: 1,
        revision: 1,
      },
    ],
  };
}

function warmReuseAttempt(id: string, triggerMessageId: string) {
  return {
    id,
    triggerMessageId,
    status: 'completed' as const,
    startedAt: 1,
    completedAt: 2,
    revision: 1,
    // Only the always-on sandbox markers `ensureWrapper` emits for every delivery.
    steps: [
      {
        id: `${id}:provision`,
        key: 'sandbox_provision',
        kind: 'phase' as const,
        label: 'sandbox_provision',
        status: 'completed' as const,
        startedAt: 1,
        revision: 1,
      },
      {
        id: `${id}:boot`,
        key: 'sandbox_boot',
        kind: 'phase' as const,
        label: 'sandbox_boot',
        status: 'completed' as const,
        startedAt: 1,
        revision: 1,
      },
    ],
  };
}

describe('session transcript', () => {
  it('places preparation attempts after their trigger message', () => {
    const messages = [message('msg_001'), message('msg_002')];
    const attempts = [attempt('attempt_001', 'msg_001')];

    const transcript = mergeSessionTranscript(messages, attempts);

    expect(transcript.map(item => getSessionTranscriptItemKey(item))).toEqual([
      'msg_001',
      'preparation:attempt_001',
      'msg_002',
    ]);
  });

  it('keeps orphaned preparation attempts visible after paginated prepends', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_011')],
      [attempt('attempt_older', 'msg_001')]
    );

    expect(transcript.map(item => getSessionTranscriptItemKey(item))).toEqual([
      'msg_011',
      'preparation:attempt_older',
    ]);
  });

  it('hides warm-reuse completed attempts that only ran synthetic sandbox markers', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_001')],
      [warmReuseAttempt('attempt_warm', 'msg_001')]
    );

    expect(transcript.map(item => getSessionTranscriptItemKey(item))).toEqual(['msg_001']);
  });

  it('keeps a running attempt even if it only has synthetic markers so far', () => {
    const running = {
      ...warmReuseAttempt('attempt_running', 'msg_001'),
      status: 'running' as const,
      completedAt: undefined,
    };
    const transcript = mergeSessionTranscript([message('msg_001')], [running]);

    expect(transcript.map(item => getSessionTranscriptItemKey(item))).toEqual([
      'msg_001',
      'preparation:attempt_running',
    ]);
  });
});
