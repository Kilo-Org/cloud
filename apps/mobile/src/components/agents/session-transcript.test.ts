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
    steps: [],
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
});
