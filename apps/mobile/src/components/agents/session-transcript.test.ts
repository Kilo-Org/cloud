/* eslint-disable max-lines -- Marker rules need one fixture per state; the file is a single builder harness. */
import { describe, expect, it, vi } from 'vitest';

import {
  collectTranscriptItemKeysByPart,
  condenseTranscriptToolRuns,
  getSessionTranscriptItemKey,
  getSessionTranscriptItemMessageId,
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

/**
 * A client-materialised row for a submission the server has not confirmed:
 * `info.synthetic` on the message row plus the `synthetic` placeholder text
 * part, exactly as `insertOptimisticUserMessage` and
 * `synthesizeQueuedUserMessage` write them.
 */
function syntheticUserMessageWithText(id: string, text: string) {
  return {
    info: {
      ...message(id).info,
      synthetic: true,
    },
    parts: [
      {
        id: `${id}-text`,
        sessionID: 'ses_12345678901234567890123456',
        messageID: id,
        type: 'text' as const,
        text,
        synthetic: true,
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

/** Whether `original` still appears as one unbroken run at the end of `next`. */
function isContiguousSuffix(original: string[], next: string[]): boolean {
  if (original.length > next.length) {
    return false;
  }
  const offset = next.length - original.length;
  return original.every((key, index) => next[offset + index] === key);
}

function messageIdsOf(items: ReturnType<typeof mergeSessionTranscript>): (string | null)[] {
  return items.map(item => getSessionTranscriptItemMessageId(item));
}

describe('getSessionTranscriptItemMessageId', () => {
  it('maps a message row to its message id', () => {
    const transcript = mergeSessionTranscript([message('msg_001')], []);

    // The burst marker rides on the message item, so the row count is one per
    // message and the marker adds no row of its own.
    expect(keysOf(transcript)).toEqual(['msg_001']);
    expect(messageIdsOf(transcript)).toEqual(['msg_001']);
  });

  it('maps a preparation row to null — it renders no message row of its own', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_001')],
      [attempt('attempt_001', 'msg_001')]
    );

    expect(messageIdsOf(transcript)).toEqual(['msg_001', null]);
  });

  it("maps a condensed tool run to its first part's message id", () => {
    const base = 1_000_000_000;
    const condensed = condenseTranscriptToolRuns(
      mergeSessionTranscript(
        [
          assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
          assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1']),
        ],
        []
      )
    );

    expect(keysOf(condensed)).toEqual(['tool-run:ta1']);
    expect(messageIdsOf(condensed)).toEqual(['msg_tool_a']);
  });
});

describe('session transcript', () => {
  it('places preparation attempts after their trigger message', () => {
    const messages = [message('msg_001'), message('msg_002')];
    const attempts = [attempt('attempt_001', 'msg_001')];

    const transcript = mergeSessionTranscript(messages, attempts);

    expect(keysOf(transcript)).toEqual(['msg_001', 'preparation:attempt_001', 'msg_002']);
  });

  it('keeps orphaned preparation attempts visible after paginated prepends', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_011')],
      [attempt('attempt_older', 'msg_001')]
    );

    expect(keysOf(transcript)).toEqual(['msg_011', 'preparation:attempt_older']);
  });

  it('hides warm-reuse completed attempts that only ran synthetic sandbox markers', () => {
    const transcript = mergeSessionTranscript(
      [message('msg_001')],
      [warmReuseAttempt('attempt_warm', 'msg_001')]
    );

    expect(keysOf(transcript)).toEqual(['msg_001']);
  });

  it('keeps a running attempt even if it only has synthetic markers so far', () => {
    const running = {
      ...warmReuseAttempt('attempt_running', 'msg_001'),
      status: 'running' as const,
      completedAt: undefined,
    };
    const transcript = mergeSessionTranscript([message('msg_001')], [running]);

    expect(keysOf(transcript)).toEqual(['msg_001', 'preparation:attempt_running']);
  });

  it('opens a burst of ten visible messages inside one minute with exactly one marker, on the first message', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      userMessageAt(`msg_burst_${i}`, 1_000_000_000 + i * 1000)
    );

    const transcript = mergeSessionTranscript(messages, []);

    expect(keysOf(transcript)).toEqual(messages.map(m => m.info.id));
    const marked = transcript.filter(
      item => item.type === 'message' && item.timeMarker !== undefined
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ message: { info: { id: 'msg_burst_0' } } });
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
    expect(keysOf(atGap)).toEqual(['msg_gap_a', 'msg_gap_b']);
    expect(atGap.map(item => (item.type === 'message' ? item.timeMarker : undefined))).toEqual([
      { created: base, dayChanged: false },
      { created: base + TRANSCRIPT_TIME_MARKER_GAP_MS, dayChanged: false },
    ]);

    const belowGap = mergeSessionTranscript(
      [
        userMessageAt('msg_gap_c', base),
        userMessageAt('msg_gap_d', base + TRANSCRIPT_TIME_MARKER_GAP_MS - 1),
      ],
      []
    );
    expect(keysOf(belowGap)).toEqual(['msg_gap_c', 'msg_gap_d']);
    expect(belowGap[1]).toMatchObject({ type: 'message' });
    expect(belowGap[1]?.type === 'message' ? belowGap[1].timeMarker : undefined).toBeUndefined();
  });

  it('keeps the page-2 key sequence a contiguous suffix after an older message is prepended', () => {
    const minute = 60_000;
    const base = 100 * minute;
    // Page 2 as the reader first sees it: two user messages a minute apart.
    const page2 = [userMessageAt('m2', base), userMessageAt('m3', base + minute)];
    const before = keysOf(mergeSessionTranscript(page2, []));
    expect(before).toEqual(['m2', 'm3']);

    // Loading older messages prepends `m1` a minute before the page's first row.
    const merged = mergeSessionTranscript([userMessageAt('m1', base - minute), ...page2], []);
    const after = keysOf(merged);

    // FlashList anchors on row keys: the keys that were on screen must still be
    // present, unchanged and contiguous. The burst marker now rides on the
    // message item, so it moving from `m2` to `m1` changes no key.
    expect(isContiguousSuffix(before, after)).toBe(true);
    expect(after).toEqual(['m1', 'm2', 'm3']);
    expect(merged[0]).toMatchObject({ type: 'message', timeMarker: { created: base - minute } });
    expect(merged[1]).toMatchObject({ type: 'message' });
    expect(merged[1]?.type === 'message' ? merged[1].timeMarker : undefined).toBeUndefined();
  });

  it('keeps a condensed tool run key when an older tool-only page is prepended', () => {
    const base = 1_000_000_000;
    // Page 2 as the reader first sees it: a lone tool-only message condenses to
    // its message row, because a run of one falls back to the message.
    const page2 = [assistantToolOnlyMessageAt('m2', base, ['t2'])];
    const before = condenseTranscriptToolRuns(mergeSessionTranscript(page2, []));
    expect(keysOf(before)).toEqual(['m2']);

    // Loading older messages prepends an older tool-only message in the same
    // burst: its part joins t2 into one run. The carried map pins the run to the
    // key the row was already on screen under, so FlashList holds the viewport.
    const merged = mergeSessionTranscript(
      [assistantToolOnlyMessageAt('m1', base - 1000, ['t1']), ...page2],
      []
    );
    const after = keysOf(
      condenseTranscriptToolRuns(merged, collectTranscriptItemKeysByPart(before))
    );

    expect(after).toEqual(['m2']);
    expect(isContiguousSuffix(keysOf(before), after)).toBe(true);

    // With no carried map the output is byte-identical to before this change:
    // the run still names itself after its first part. The component is what
    // threads the map; the pure contract stays the same.
    expect(keysOf(condenseTranscriptToolRuns(merged))).toEqual(['tool-run:t1']);
  });

  it('marks a day change even when the gap is small, carrying dayChanged on the marker', () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 10).getTime();

    const transcript = mergeSessionTranscript(
      [userMessageAt('msg_day_a', beforeMidnight), userMessageAt('msg_day_b', afterMidnight)],
      []
    );

    expect(keysOf(transcript)).toEqual(['msg_day_a', 'msg_day_b']);
    expect(transcript[0]).toMatchObject({ type: 'message', timeMarker: { dayChanged: false } });
    expect(transcript[1]).toMatchObject({ type: 'message', timeMarker: { dayChanged: true } });
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

    const markers = transcript.flatMap(item =>
      item.type === 'message' && item.timeMarker ? [item.timeMarker] : []
    );
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

    expect(keysOf(withInvisible)).toEqual(['msg_vis_a', 'msg_vis_b']);
    expect(keysOf(withInvisible)).toEqual(keysOf(withoutInvisible));
  });

  it('keeps a sanitized-empty user message when its delivery failed', () => {
    const failedMessage = userMessageWithText('msg_failed', '<script>hidden</script>');

    const transcript = mergeSessionTranscript(
      [failedMessage],
      [],
      new Map([[failedMessage.info.id, { status: 'failed', error: 'nope', reason: 'exhausted' }]])
    );

    expect(keysOf(transcript)).toEqual(['msg_failed']);
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

    expect(keysOf(transcript)).toEqual(['msg_time_a', 'msg_time_b', 'msg_time_c']);

    const maxValueTranscript = mergeSessionTranscript(
      [
        userMessageAt('msg_max_a', base),
        userMessageWithCreatedAt('msg_max_b', Number.MAX_VALUE),
        userMessageAt('msg_max_c', base + 2000),
      ],
      []
    );
    expect(keysOf(maxValueTranscript)).toEqual(['msg_max_a', 'msg_max_b', 'msg_max_c']);
  });

  it('assigns each marker to the message that opens its burst and to no other', () => {
    const base = 1_000_000_000;
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 10).getTime();

    const transcript = mergeSessionTranscript(
      [
        userMessageAt('msg_open_a', base),
        userMessageAt('msg_burst_b', base + 1000),
        userMessageAt('msg_gap_c', base + 1000 + TRANSCRIPT_TIME_MARKER_GAP_MS),
        userMessageAt('msg_day_d', beforeMidnight),
        userMessageAt('msg_day_e', afterMidnight),
      ],
      []
    );

    // The burst opener, the resumption after the gap, and the first message of
    // the new day carry a marker; the message inside each burst does not.
    const markedIds = transcript.flatMap(item =>
      item.type === 'message' && item.timeMarker ? [item.message.info.id] : []
    );
    expect(markedIds).toEqual(['msg_open_a', 'msg_gap_c', 'msg_day_d', 'msg_day_e']);
    expect(keysOf(transcript)).toEqual([
      'msg_open_a',
      'msg_burst_b',
      'msg_gap_c',
      'msg_day_d',
      'msg_day_e',
    ]);
  });

  it('renders visible assistant messages and markers alongside user messages', () => {
    const transcript = mergeSessionTranscript(
      [
        userMessageAt('msg_user', 1_000_000_000),
        assistantMessageWithTextAt('msg_asst', 1_000_000_100),
      ],
      []
    );

    expect(keysOf(transcript)).toEqual(['msg_user', 'msg_asst']);
  });

  it('renders one unconfirmed submission as one message item', () => {
    // Production (ses_f58dc0cebfffJoPUmXs05c76pv): the client materialises one
    // row per prompt, keyed by the `messageId` the send carries, and the server
    // honors that id (the run's id `msg_0a72cbf8f000Ab0W20uOzcDzjS` is the
    // client format), so the submission renders once whether or not the
    // authoritative `message.updated` — here rejected wholesale
    // (`event_batch_rejected`) — ever lands.
    const optimistic = syntheticUserMessageWithText('msg_opt', 'Continue');

    const transcript = mergeSessionTranscript([optimistic], []);
    expect(transcript.filter(item => item.type === 'message')).toHaveLength(1);
    expect(keysOf(transcript)).toEqual(['msg_opt']);

    // The recorded failed run keeps that one row, so the typed failure footer
    // stays attached to the submission that failed.
    const failed = mergeSessionTranscript(
      [optimistic],
      [],
      new Map([
        ['msg_opt', { status: 'failed', error: 'Unauthorized: Unauthorized', reason: 'exhausted' }],
      ])
    );
    expect(keysOf(failed)).toEqual(['msg_opt']);
  });

  it('keeps two submissions that carry the same prompt as two rows', () => {
    // The reported session submitted twice within 1.5 s (22:25:57.431Z and
    // 22:25:59.068Z: two runs, two ids). Two rows with the same prompt are two
    // submissions the user made; merging them by prompt text would drop one.
    const first = syntheticUserMessageWithText('msg_first', 'Continue');
    const second = syntheticUserMessageWithText('msg_second', 'Continue');

    expect(
      mergeSessionTranscript([first, second], []).filter(i => i.type === 'message')
    ).toHaveLength(2);
  });

  it('keeps two confirmed rows with the same prompt as two submissions', () => {
    const first = userMessageWithTextAt('msg_first', 1_000_000_000, 'Continue');
    const second = userMessageWithTextAt('msg_second', 1_000_000_000 + 60_000, 'Continue');

    const transcript = mergeSessionTranscript([first, second], []);
    expect(transcript.filter(item => item.type === 'message')).toHaveLength(2);
  });

  it('drops an unconfirmed row with no renderable content instead of an empty stub', () => {
    // The optimistic row materialised for a prompt whose text never became
    // renderable: a confirmed row would wait for its parts to stream, but
    // nothing will fill a client-materialised one — it must not leave an
    // empty bubble.
    const stub = {
      info: { ...message('msg_stub').info, synthetic: true },
      parts: [],
    };
    const transcript = mergeSessionTranscript([stub], []);
    expect(transcript.filter(item => item.type === 'message')).toHaveLength(0);

    // With the run recorded failed the row stays for the typed footer.
    const failed = mergeSessionTranscript(
      [stub],
      [],
      new Map([['msg_stub', { status: 'failed', error: 'boom', reason: 'execution' }]])
    );
    expect(keysOf(failed)).toEqual(['msg_stub']);

    // A confirmed zero-part row keeps the transient rendering.
    const transient = mergeSessionTranscript([message('msg_transient')], []);
    expect(keysOf(transient)).toEqual(['msg_transient']);
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

    expect(keysOf(condensed)).toEqual(['tool-run:ta1']);
    const run = condensed.find(item => item.type === 'tool-run');
    expect(run?.parts.map(part => part.id)).toEqual(['ta1', 'ta2', 'tb1']);
  });

  it('keeps a run key when a lone tool row becomes a run while streaming', () => {
    const base = 1_000_000_000;
    // A lone tool-only message first renders as its message row (a run of one).
    const page1 = [assistantToolOnlyMessageAt('m1', base, ['t1'])];
    const before = condenseTranscriptToolRuns(mergeSessionTranscript(page1, []));
    expect(keysOf(before)).toEqual(['m1']);

    // A later assistant message's leading tool part streams in and joins the run.
    // The carried map pins the run to the key the row already had.
    const after = condenseTranscriptToolRuns(
      mergeSessionTranscript(
        [
          assistantToolOnlyMessageAt('m1', base, ['t1']),
          assistantToolOnlyMessageAt('m2', base + 1000, ['t2']),
        ],
        []
      ),
      collectTranscriptItemKeysByPart(before)
    );

    expect(keysOf(after)).toEqual(['m1']);
  });

  it('falls back to the first part id when a carried key is already taken', () => {
    const base = 1_000_000_000;
    // One run holds four parts and keys every one of them `tool-run:t1`.
    const before = condenseTranscriptToolRuns(
      mergeSessionTranscript([assistantToolOnlyMessageAt('m1', base, ['t1', 't2', 't3', 't4'])], [])
    );
    expect(keysOf(before)).toEqual(['tool-run:t1']);

    // The run now splits at a user message. The first half reuses the carried
    // key; the second half can no longer take it and falls back to its own
    // first part's id, so one carried key is never emitted twice.
    const after = condenseTranscriptToolRuns(
      mergeSessionTranscript(
        [
          assistantToolOnlyMessageAt('m1', base, ['t1', 't2']),
          userMessageWithTextAt('u', base + 500, 'between'),
          assistantToolOnlyMessageAt('m2', base + 1000, ['t3', 't4']),
        ],
        []
      ),
      collectTranscriptItemKeysByPart(before)
    );

    expect(keysOf(after)).toEqual(['tool-run:t1', 'u', 'tool-run:t3']);
  });

  it.each([true, false])(
    'reserves a later failed message key after a run adopted it (retryable: %s)',
    isRetryable => {
      const base = 1_000_000_000;
      const owner = assistantToolOnlyMessageAt('m2', base + 1000, ['t2']);
      const lone = condenseTranscriptToolRuns(mergeSessionTranscript([owner], []));
      const older = assistantToolOnlyMessageAt('m1', base, ['t1a', 't1b']);
      const joined = condenseTranscriptToolRuns(
        mergeSessionTranscript([older, owner], []),
        collectTranscriptItemKeysByPart(lone)
      );
      expect(keysOf(joined)).toEqual(['m2']);

      const failed = {
        ...owner,
        info: {
          ...owner.info,
          error: { name: 'APIError' as const, data: { message: 'boom', isRetryable } },
        },
      };
      const after = condenseTranscriptToolRuns(
        mergeSessionTranscript([older, failed], []),
        collectTranscriptItemKeysByPart(joined)
      );

      expect(keysOf(after)).toEqual(['tool-run:t1a', 'm2']);
      expect(after[1]).toMatchObject({ type: 'message', message: failed });
      expect(toolPartCount(after)).toBe(3);
    }
  );

  it('reserves a later plain fragment key after a run adopted it', () => {
    const base = 1_000_000_000;
    const owner = assistantToolOnlyMessageAt('m2', base + 1000, ['t2']);
    const lone = condenseTranscriptToolRuns(mergeSessionTranscript([owner], []));
    const older = assistantToolOnlyMessageAt('m1', base, ['t1a', 't1b']);
    const joined = condenseTranscriptToolRuns(
      mergeSessionTranscript([older, owner], []),
      collectTranscriptItemKeysByPart(lone)
    );
    const after = condenseTranscriptToolRuns(
      mergeSessionTranscript(
        [older, assistantTextThenToolsMessageAt('m2', base + 1000, ['t2'])],
        []
      ),
      collectTranscriptItemKeysByPart(joined)
    );

    expect(keysOf(after)).toEqual(['tool-run:t1a', 'm2']);
    expect(toolPartCount(after)).toBe(3);
  });

  it('reserves the default key of a later run when an adopted run splits again', () => {
    const base = 1_000_000_000;
    const owner = assistantToolOnlyMessageAt('m2', base + 1000, ['t2a', 't2b']);
    const before = condenseTranscriptToolRuns(mergeSessionTranscript([owner], []));
    const older = assistantToolOnlyMessageAt('m1', base, ['t1a', 't1b']);
    const joined = condenseTranscriptToolRuns(
      mergeSessionTranscript([older, owner], []),
      collectTranscriptItemKeysByPart(before)
    );
    expect(keysOf(joined)).toEqual(['tool-run:t2a']);
    const after = condenseTranscriptToolRuns(
      mergeSessionTranscript([older, userMessageWithTextAt('u', base + 500, 'between'), owner], []),
      collectTranscriptItemKeysByPart(joined)
    );

    expect(keysOf(after)).toEqual(['tool-run:t1a', 'u', 'tool-run:t2a']);
    expect(toolPartCount(after)).toBe(4);
  });

  it('splits the run around a user message', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      userMessageWithTextAt('msg_user', base + 500, 'between'),
      assistantToolOnlyMessageAt('msg_tool_b', base + 1000, ['tb1', 'tb2']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual(['tool-run:ta1', 'msg_user', 'tool-run:tb1']);
  });

  it('splits the run at every message that carries a time marker, keeping the markers', () => {
    const base = 1_000_000_000;
    const messages = [
      assistantToolOnlyMessageAt('msg_tool_a', base, ['ta1', 'ta2']),
      assistantToolOnlyMessageAt('msg_tool_b', base + TRANSCRIPT_TIME_MARKER_GAP_MS, [
        'tb1',
        'tb2',
      ]),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    // A marked message is a burst boundary exactly as the standalone marker item
    // was, and each marker rides on the run that opens its burst.
    expect(keysOf(condensed)).toEqual(['tool-run:ta1', 'tool-run:tb1']);
    expect(condensed.map(item => (item.type === 'tool-run' ? item.timeMarker : undefined))).toEqual(
      [
        { created: base, dayChanged: false },
        { created: base + TRANSCRIPT_TIME_MARKER_GAP_MS, dayChanged: false },
      ]
    );
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
    expect(keysOf(condensed)).toEqual(['message-parts:msg_mixed:msg_mixed:text', 'tool-run:tm1']);
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

    expect(keysOf(condensed)).toEqual(['tool-run:ta1', 'message-parts:msg_mixed:msg_mixed:text']);
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
    expect(keysOf(condensed)).toEqual(['msg_mixed']);
    const lone = condensed.find(item => item.type === 'message');
    expect(lone?.type === 'message' ? lone.parts : undefined).toBeUndefined();
  });

  it('keeps the original message item for a run of one', () => {
    const base = 1_000_000_000;
    const messages = [assistantToolOnlyMessageAt('msg_lone', base, ['t1'])];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual(['msg_lone']);
    expect(condensed.some(item => item.type === 'tool-run')).toBe(false);
  });

  it('keeps the burst marker when a marked message opens a run of one', () => {
    const base = 1_000_000_000;
    // The first message of the page opens a burst, and its only visible part is
    // a lone tool call: the run collapses back to the message fragment, which
    // must still carry the marker or the reader loses the timestamp.
    const messages = [assistantToolOnlyMessageAt('msg_lone_marked', base, ['t1'])];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    expect(keysOf(condensed)).toEqual(['msg_lone_marked']);
    const lone = condensed.find(item => item.type === 'message');
    expect(lone?.type === 'message' ? lone.timeMarker : undefined).toEqual({
      created: base,
      dayChanged: false,
    });
  });

  it('keeps the burst marker when a lone tool run follows a hidden message', () => {
    const base = 1_000_000_000;
    // A marked resumption whose only visible part is a lone tool call: the run
    // of one falls back to the message fragment and keeps its marker.
    const messages = [
      userMessageAt('msg_open', base),
      assistantToolOnlyMessageAt('msg_resume', base + TRANSCRIPT_TIME_MARKER_GAP_MS, ['t1']),
    ];

    const condensed = condenseTranscriptToolRuns(mergeSessionTranscript(messages, []));

    const resumed = condensed.find(
      item => item.type === 'message' && item.message.info.id === 'msg_resume'
    );
    expect(resumed?.type === 'message' ? resumed.timeMarker : undefined).toEqual({
      created: base + TRANSCRIPT_TIME_MARKER_GAP_MS,
      dayChanged: false,
    });
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

    expect(keysOf(condensed)).toEqual(['msg_plan_lone']);
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

    expect(keysOf(condensed)).toEqual(['tool-run:ta1', 'msg_failed', 'tool-run:tc1']);
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
