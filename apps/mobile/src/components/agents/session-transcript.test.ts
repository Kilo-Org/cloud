/* eslint-disable max-lines -- Marker rules need one fixture per state; the file is a single builder harness. */
import { describe, expect, it } from 'vitest';

import {
  getSessionTranscriptItemKey,
  mergeSessionTranscript,
  TRANSCRIPT_TIME_MARKER_GAP_MS,
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

function userMessageAt(id: string, created: number) {
  const base = message(id);
  base.info.time = { created };
  return base;
}

function assistantMessageWithTextAt(id: string, created: number) {
  return {
    info: {
      id,
      sessionID: 'ses_12345678901234567890123456',
      role: 'assistant' as const,
      time: { created },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}:text`,
        sessionID: 'ses_12345678901234567890123456',
        messageID: id,
        type: 'text' as const,
        text: 'visible',
      },
    ],
  };
}

function assistantMessageWithStepStartOnly(id: string, created: number) {
  return {
    info: {
      id,
      sessionID: 'ses_12345678901234567890123456',
      role: 'assistant' as const,
      time: { created },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}:step-start`,
        sessionID: 'ses_12345678901234567890123456',
        messageID: id,
        type: 'step-start' as const,
      },
    ],
  };
}

function userMessageWithCreatedAt(id: string, created: number | undefined) {
  const base = message(id);
  if (created === undefined) {
    (base.info.time as { created?: number }).created = undefined;
  } else {
    base.info.time = { created };
  }
  return base;
}

function keysOf(items: ReturnType<typeof mergeSessionTranscript>): string[] {
  return items.map(item => getSessionTranscriptItemKey(item));
}

describe('session transcript', () => {
  it('places preparation attempts after their trigger message', () => {
    const messages = [message('msg_001'), message('msg_002')];
    const attempts = [attempt('attempt_001', 'msg_001')];

    const transcript = mergeSessionTranscript(messages, attempts);

    expect(keysOf(transcript)).toEqual([
      'time:msg_001',
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

    expect(keysOf(transcript)).toEqual(['time:msg_011', 'msg_011', 'preparation:attempt_older']);
  });

  it('hides warm-reuse completed attempts that only ran synthetic sandbox markers', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_001')],
      [warmReuseAttempt('attempt_warm', 'msg_001')]
    );

    expect(keysOf(transcript)).toEqual(['time:msg_001', 'msg_001']);
  });

  it('keeps a running attempt even if it only has synthetic markers so far', () => {
    const running = {
      ...warmReuseAttempt('attempt_running', 'msg_001'),
      status: 'running' as const,
      completedAt: undefined,
    };
    const transcript = mergeSessionTranscript([message('msg_001')], [running]);

    expect(keysOf(transcript)).toEqual(['time:msg_001', 'msg_001', 'preparation:attempt_running']);
  });

  it('opens a burst of ten visible messages inside one minute with exactly one marker, the first item', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      userMessageAt(`msg_burst_${i}`, 1_000_000_000 + i * 1000)
    );

    const transcript = mergeSessionTranscript(messages, []);

    expect(keysOf(transcript)).toEqual(['time:msg_burst_0', ...messages.map(m => m.info.id)]);
    expect(transcript.filter(item => item.type === 'time')).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ type: 'time', messageId: 'msg_burst_0' });
  });

  it('marks a resumption when the gap reaches the threshold, and not one millisecond below it', () => {
    const base = 1_000_000_000;

    const atGap = mergeSessionTranscript(
      [
        userMessageAt('msg_gap_a', base),
        userMessageAt('msg_gap_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS),
      ],
      []
    );
    expect(keysOf(atGap)).toEqual(['time:msg_gap_a', 'msg_gap_a', 'time:msg_gap_b', 'msg_gap_b']);

    const belowGap = mergeSessionTranscript(
      [
        userMessageAt('msg_gap_c', base),
        userMessageAt('msg_gap_d', base + TRANSCRIPT_TIME_MARKER_GAP_MS - 1),
      ],
      []
    );
    expect(keysOf(belowGap)).toEqual(['time:msg_gap_c', 'msg_gap_c', 'msg_gap_d']);
  });

  it('marks a day change even when the gap is small, carrying dayChanged on the marker', () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 10).getTime();

    const transcript = mergeSessionTranscript(
      [userMessageAt('msg_day_a', beforeMidnight), userMessageAt('msg_day_b', afterMidnight)],
      []
    );

    expect(keysOf(transcript)).toEqual([
      'time:msg_day_a',
      'msg_day_a',
      'time:msg_day_b',
      'msg_day_b',
    ]);
    expect(transcript[0]).toMatchObject({ type: 'time', dayChanged: false });
    expect(transcript[2]).toMatchObject({ type: 'time', dayChanged: true });
  });

  it('carries dayChanged false on every marker except a true day change', () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 10).getTime();
    const later = afterMidnight + 60_000;

    const transcript = mergeSessionTranscript(
      [
        userMessageAt('msg_dc_a', beforeMidnight),
        userMessageAt('msg_dc_b', afterMidnight),
        userMessageAt('msg_dc_c', later),
      ],
      []
    );

    const markers = transcript.filter(item => item.type === 'time');
    expect(markers.map(marker => marker.dayChanged)).toEqual([false, true]);
  });

  it('drops an invisible message and its would-be marker, keeping the surviving marker count', () => {
    const base = 1_000_000_000;
    const withoutInvisible = mergeSessionTranscript(
      [
        userMessageAt('msg_vis_a', base),
        userMessageAt('msg_vis_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS),
      ],
      []
    );
    const withInvisible = mergeSessionTranscript(
      [
        userMessageAt('msg_vis_a', base),
        assistantMessageWithStepStartOnly('msg_hidden', base + 10_000),
        userMessageAt('msg_vis_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS),
      ],
      []
    );

    expect(keysOf(withInvisible)).toEqual([
      'time:msg_vis_a',
      'msg_vis_a',
      'time:msg_vis_b',
      'msg_vis_b',
    ]);
    expect(keysOf(withInvisible)).toEqual(keysOf(withoutInvisible));
  });

  it('keeps an invalid-timestamp message visible without a marker and without resetting the run', () => {
    const base = 1_000_000_000;
    const transcript = mergeSessionTranscript(
      [
        userMessageAt('msg_time_a', base),
        userMessageWithCreatedAt('msg_time_b', undefined),
        userMessageAt('msg_time_c', base + 2000),
      ],
      []
    );

    expect(keysOf(transcript)).toEqual([
      'time:msg_time_a',
      'msg_time_a',
      'msg_time_b',
      'msg_time_c',
    ]);

    const maxValueTranscript = mergeSessionTranscript(
      [
        userMessageAt('msg_max_a', base),
        userMessageWithCreatedAt('msg_max_b', Number.MAX_VALUE),
        userMessageAt('msg_max_c', base + 2000),
      ],
      []
    );
    expect(keysOf(maxValueTranscript)).toEqual([
      'time:msg_max_a',
      'msg_max_a',
      'msg_max_b',
      'msg_max_c',
    ]);
  });

  it('keeps every fixture free of a trailing marker and of adjacent markers', () => {
    const base = 1_000_000_000;
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 10).getTime();

    const transcripts = [
      mergeSessionTranscript(
        [message('msg_001'), message('msg_002')],
        [attempt('attempt_001', 'msg_001')]
      ),
      mergeSessionTranscript([message('msg_011')], [attempt('attempt_older', 'msg_001')]),
      mergeSessionTranscript([message('msg_001')], [warmReuseAttempt('attempt_warm', 'msg_001')]),
      mergeSessionTranscript(
        [
          userMessageAt('msg_gap_a', base),
          userMessageAt('msg_gap_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS),
        ],
        []
      ),
      mergeSessionTranscript(
        [userMessageAt('msg_day_a', beforeMidnight), userMessageAt('msg_day_b', afterMidnight)],
        []
      ),
      mergeSessionTranscript(
        [
          userMessageAt('msg_vis_a', base),
          assistantMessageWithStepStartOnly('msg_hidden', base + 10_000),
          userMessageAt('msg_vis_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS),
        ],
        []
      ),
      mergeSessionTranscript(
        [
          userMessageAt('msg_time_a', base),
          userMessageWithCreatedAt('msg_time_b', undefined),
          userMessageAt('msg_time_c', base + 2000),
        ],
        []
      ),
    ];

    for (const transcript of transcripts) {
      const keys = keysOf(transcript);
      expect(keys.at(-1)?.startsWith('time:')).toBe(false);
      for (let i = 1; i < keys.length; i += 1) {
        expect(keys[i - 1]?.startsWith('time:') && keys[i]?.startsWith('time:')).toBe(false);
      }
    }
  });

  it('renders visible assistant messages and markers alongside user messages', () => {
    const transcript = mergeSessionTranscript(
      [
        userMessageAt('msg_user', 1_000_000_000),
        assistantMessageWithTextAt('msg_asst', 1_000_000_100),
      ],
      []
    );

    expect(keysOf(transcript)).toEqual(['time:msg_user', 'msg_user', 'msg_asst']);
  });
});
