/* eslint-disable max-lines -- Marker rules need one fixture per state; the file is a single builder harness. */
import { describe, expect, it, vi } from 'vitest';

import {
  condenseTranscriptToolRuns,
  getSessionTranscriptItemKey,
  mergeSessionTranscript,
  TRANSCRIPT_TIME_MARKER_GAP_MS,
} from '@/components/agents/session-transcript';

// `session-transcript` now pulls `session-tool-run`, whose tool-card projection
// imports the lucide icon barrel. The pure project cannot parse the Flow-sourced
// react-native runtime, so stub the icon module with sentinels (same set the
// session-tool-run tests stub).
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Eye: 'Eye',
  FileDiff: 'FileDiff',
  FilePlus: 'FilePlus',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Globe: 'Globe',
  ListTodo: 'ListTodo',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  Sparkles: 'Sparkles',
  Terminal: 'Terminal',
}));

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

function userMessageWithText(id: string, text: string) {
  return {
    ...message(id),
    parts: [
      {
        id: `${id}:text`,
        sessionID: 'ses_12345678901234567890123456',
        messageID: id,
        type: 'text' as const,
        text,
      },
    ],
  };
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

function userMessageWithTextAt(id: string, created: number, text: string) {
  const base = userMessageWithText(id, text);
  base.info.time = { created };
  return base;
}

function toolPart(id: string, tool = 'read') {
  return {
    id,
    sessionID: 'ses_12345678901234567890123456',
    messageID: 'm0',
    type: 'tool' as const,
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed' as const,
      input: {},
      output: '',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function assistantToolOnlyMessageAt(id: string, created: number, partIds: string[]) {
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
    parts: partIds.map(partId => toolPart(partId)),
  };
}

function assistantMixedMessageAt(id: string, created: number, partIds: string[]) {
  const base = assistantToolOnlyMessageAt(id, created, partIds);
  return {
    info: base.info,
    parts: [
      ...base.parts,
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

/** A mixed assistant message whose visible text precedes its tool parts. */
function assistantTextThenToolsMessageAt(id: string, created: number, partIds: string[]) {
  const base = assistantToolOnlyMessageAt(id, created, partIds);
  return {
    info: base.info,
    parts: [
      {
        id: `${id}:text`,
        sessionID: 'ses_12345678901234567890123456',
        messageID: id,
        type: 'text' as const,
        text: 'visible',
      },
      ...base.parts,
    ],
  };
}

function toolPartCount(items: ReturnType<typeof mergeSessionTranscript>): number {
  let total = 0;
  for (const item of items) {
    if (item.type === 'tool-run') {
      total += item.parts.length;
    } else if (item.type === 'message') {
      // A split message carries the parts it actually renders; a plain message
      // renders all of its parts. Count exactly what the item would show.
      const parts = item.parts ?? item.message.parts;
      total += parts.filter(part => part.type === 'tool').length;
    }
  }
  return total;
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

  it('keeps a sanitized-empty user message when its delivery failed', () => {
    const failedMessage = userMessageWithText('msg_failed', '<script>hidden</script>');

    const transcript = mergeSessionTranscript(
      [failedMessage],
      [],
      new Map([[failedMessage.info.id, { status: 'failed', error: 'nope', reason: 'exhausted' }]])
    );

    expect(keysOf(transcript)).toEqual(['time:msg_failed', 'msg_failed']);
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

describe('condenseTranscriptToolRuns', () => {
  it('merges two consecutive tool-only assistant messages into one run in order', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual(['time:msg_tool_a', 'tool-run:ta1']);
    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['ta1', 'ta2', 'tb1']);
  });

  it('splits the run around a user message', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      userMessageWithTextAt('msg_user', base + 500, 'between'),
      assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1', 'tb2']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual([
      'time:msg_tool_a',
      'tool-run:ta1',
      'msg_user',
      'tool-run:tb1',
    ]);
  });

  it('splits the run around a time marker', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      assistantToolOnlyMessageAt('msg_tool_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS, [
        'tb1',
        'tb2',
      ]),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual([
      'time:msg_tool_a',
      'tool-run:ta1',
      'time:msg_tool_b',
      'tool-run:tb1',
    ]);
  });

  it('carries a mixed message trailing tool run into the following message', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantTextThenToolsMessageAt('msg_mixed', base, ['tm1']),
      assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    // The text fragment precedes the run: text, read, bash reads as text then a
    // single "<2> items" row instead of two expanded cards.
    expect(keysOf(condensed)).toEqual([
      'time:msg_mixed',
      'message-parts:msg_mixed:msg_mixed:text',
      'tool-run:tm1',
    ]);
    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['tm1', 'tb1']);
    const fragment = condensed.find(item => item.type === 'message');
    expect(fragment?.type === 'message' ? fragment.parts?.map(part => part.id) : []).toEqual([
      'msg_mixed:text',
    ]);
  });

  it('prepends a mixed message leading tool run to the preceding run', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      // Tools then text: the mixed message's leading tools join the run.
      assistantMixedMessageAt('msg_mixed', base + 1000, ['tm1']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual([
      'time:msg_tool_a',
      'tool-run:ta1',
      'message-parts:msg_mixed:msg_mixed:text',
    ]);
    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['ta1', 'ta2', 'tm1']);
  });

  it('splits a mixed assistant message around its text so tool runs stay independent', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      assistantMixedMessageAt('msg_mixed', base + 1000, ['tm1', 'tm2']),
      assistantToolOnlyMessageAt('msg_tool_b', base + 2000, ['tb1', 'tb2']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual([
      'time:msg_tool_a',
      'tool-run:ta1',
      'message-parts:msg_mixed:msg_mixed:text',
      'tool-run:tb1',
    ]);
    const runs = condensed.filter(item => item.type === 'tool-run');
    expect(runs.map(run => run.parts.map(part => part.id))).toEqual([
      ['ta1', 'ta2', 'tm1', 'tm2'],
      ['tb1', 'tb2'],
    ]);
    const mixed = condensed.find(item => item.type === 'message');
    expect(mixed?.message.info.id).toBe('msg_mixed');
    expect(mixed?.type === 'message' ? mixed.parts?.map(part => part.id) : []).toEqual([
      'msg_mixed:text',
    ]);
    expect(toolPartCount(condensed)).toBe(toolPartCount(mergeSessionTranscript(messages, [])));
  });

  it('keeps a lone mixed-message tool part expanded inside its message', () => {
    const base = 1_000_000_000;
    const messages = [assistantTextThenToolsMessageAt('msg_mixed', base, ['tm1'])];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    // A run of one is not condensed, so the message item is unchanged.
    expect(keysOf(condensed)).toEqual(['time:msg_mixed', 'msg_mixed']);
    const lone = condensed.find(item => item.type === 'message');
    expect(lone?.type === 'message' ? lone.parts : undefined).toBeUndefined();
  });

  it('keeps the original message item for a run of one', () => {
    const base = 1_000_000_000;
    const messages = [assistantToolOnlyMessageAt('msg_lone', base, ['t1'])];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual(['time:msg_lone', 'msg_lone']);
    expect(condensed.some(item => item.type === 'tool-run')).toBe(false);
  });

  it('keeps a failed last tool call in the run so the row can show its status', () => {
    const base = 1_000_000_000;
    const failedPart = {
      ...toolPart('ta2'),
      state: {
        status: 'error' as const,
        input: {},
        error: 'boom',
        time: { start: 0, end: 1 },
      },
    };
    const failedMessage = {
      ...assistantToolOnlyMessageAt('msg_tool_failed', base + 1000, []),
      parts: [failedPart],
    };

    const condensed = condenseTranscriptToolRuns(
      mergeSessionTranscript(
        [assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1']), failedMessage],
        []
      )
    );

    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['ta1', 'ta2']);
    expect(run?.parts.at(-1)?.state.status).toBe('error');
  });

  it('excludes hidden plan-mode tool parts from the run and its count', () => {
    const base = 1_000_000_000;
    // plan_enter renders nothing on the session page, so the run must count and
    // list only the visible parts — matching what the off path renders.
    const planThenRead = {
      ...assistantToolOnlyMessageAt('msg_plan_a', base, []),
      parts: [toolPart('tp1', 'plan_enter'), toolPart('ra1')],
    };
    const messages = [planThenRead, assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1'])];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['ra1', 'tb1']);
    expect(toolPartCount(condensed)).toBe(2);
  });

  it('keeps the message item when a run holds only one visible tool part behind hidden ones', () => {
    const base = 1_000_000_000;
    const planThenRead = {
      ...assistantToolOnlyMessageAt('msg_plan_lone', base, []),
      parts: [toolPart('tp1', 'plan_enter'), toolPart('r1')],
    };

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript([planThenRead], []));

    expect(keysOf(condensed)).toEqual(['time:msg_plan_lone', 'msg_plan_lone']);
    expect(condensed.some(item => item.type === 'tool-run')).toBe(false);
  });

  it('preserves every tool part across the condensed run', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1']),
    ];
    const transcript = mergeSessionTranscript(messages, []);

    const condensed = condenseTranscriptToolRuns(transcript);

    expect(toolPartCount(condensed)).toBe(toolPartCount(transcript));
    expect(toolPartCount(condensed)).toBe(3);
  });

  it('ends the run at a failed tool-only assistant turn so its failure footer renders', () => {
    const base = 1_000_000_000;
    const failed = {
      ...assistantToolOnlyMessageAt('msg_failed', base + 1000, []),
      // A message-level failure: the turn renders a failure footer with Retry
      // instead of a condensed row, so it must split the run.
      info: {
        ...assistantToolOnlyMessageAt('msg_failed', base + 1000, []).info,
        error: {
          name: 'APIError' as const,
          data: { message: 'boom', isRetryable: true },
        },
      },
      parts: [toolPart('tf1')],
    };
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      failed,
      assistantToolOnlyMessageAt('msg_tool_c', base + 2000, ['tc1', 'tc2']),
    ];

    const transcript = mergeSessionTranscript(messages, []);
    const condensed = condenseTranscriptToolRuns(transcript);

    expect(keysOf(condensed)).toEqual([
      'time:msg_tool_a',
      'tool-run:ta1',
      'msg_failed',
      'tool-run:tc1',
    ]);
    const failedItem = condensed.find(item => keysOf([item])[0] === 'msg_failed');
    expect(failedItem?.type).toBe('message');
    for (const item of condensed) {
      if (item.type === 'tool-run') {
        expect(item.parts.map(part => part.id)).not.toContain('tf1');
      }
    }
    expect(toolPartCount(condensed)).toBe(toolPartCount(transcript));
  });
});
