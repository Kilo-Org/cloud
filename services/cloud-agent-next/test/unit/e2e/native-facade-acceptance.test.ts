import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertColdNativeSnapshot,
  assertColdRuntimeUnchanged,
  assertNativeBurst,
  classifyPermissionReply,
  injectColdPrimaryFault,
  isLiveRuntimeUnavailable,
  nativeBurstFixture,
} from '../../e2e/native-facade-acceptance.js';
import {
  createFakeLlmState,
  parseDirective,
  scenarioRegistry,
  type FakeLlmEmit,
} from '../../e2e/fake-llm-core.js';
import type { DockerCommandExecutor, SandboxContainer } from '../../e2e/sandbox-control.js';

const primary: SandboxContainer = {
  id: 'owned-primary',
  name: 'workerd-cloud-agent-next-dev-SandboxContainers-owned',
  image: 'sandbox:test',
  isProxy: false,
};
const proxy: SandboxContainer = {
  ...primary,
  id: 'owned-proxy',
  name: `${primary.name}-proxy`,
  isProxy: true,
};
const sessionID = 'ses_owned';
const user = { id: 'msg_user', sessionID, role: 'user', time: { created: 1 } };
const assistant = {
  id: 'msg_assistant',
  sessionID,
  role: 'assistant',
  parentID: user.id,
  time: { created: 2, completed: 3 },
};
const part = {
  id: 'part_text',
  sessionID,
  messageID: assistant.id,
  type: 'text',
  text: 'persisted answer',
};
const transcript = [
  { info: user, parts: [] },
  { info: assistant, parts: [part] },
];
const fence = {
  type: 'kilo.native.fence',
  properties: {
    sessionID,
    directory: `/cloud-agent/sessions/${sessionID}`,
    snapshotComplete: true,
    fence: 4,
  },
};
const snapshot = [
  { type: 'message.updated', properties: { info: user } },
  { type: 'message.updated', properties: { info: assistant } },
  { type: 'message.part.updated', properties: { part } },
  fence,
];

describe('ordinary permission autoapproval race', () => {
  const conflict = {
    status: 409,
    body: { error: 'KILO_INTERACTION_UNAVAILABLE' },
    cursor: null,
  };

  it('classifies a vanished interaction after legitimate 409 as blocked, not passed', () => {
    expect(classifyPermissionReply(conflict, [], 'per_owned')).toBe('blocked');
    expect(classifyPermissionReply(conflict, [{ id: 'per_other' }], 'per_owned')).toBe('blocked');
  });

  it('fails a rejected reply if the same interaction remains pending', () => {
    expect(() => classifyPermissionReply(conflict, [{ id: 'per_owned' }], 'per_owned')).toThrow(
      'interaction remains pending'
    );
  });

  it('accepts only an actual successful reply', () => {
    expect(
      classifyPermissionReply({ status: 200, body: true, cursor: null }, [], 'per_owned')
    ).toBe('accepted');
  });

  it('does not hide other response failures as an approval race', () => {
    for (const response of [
      { ...conflict, status: 503 },
      { ...conflict, status: 404 },
      { ...conflict, body: { error: 'OTHER_CONFLICT' } },
    ])
      expect(() => classifyPermissionReply(response, [], 'per_owned')).toThrow();
    expect(() => classifyPermissionReply(conflict, {}, 'per_owned')).toThrow();
  });
});

describe('bounded live runtime polling', () => {
  it('retries only the exact runtime-unavailable response', () => {
    expect(
      isLiveRuntimeUnavailable({
        status: 503,
        body: { error: 'KILO_LIVE_RUNTIME_UNAVAILABLE' },
        cursor: null,
      })
    ).toBe(true);
    for (const response of [
      { status: 200, body: {}, cursor: null },
      { status: 409, body: { error: 'KILO_INTERACTION_UNAVAILABLE' }, cursor: null },
      { status: 503, body: { error: 'KILO_SESSION_SNAPSHOT_PENDING' }, cursor: null },
      { status: 404, body: { error: 'KILO_LIVE_RUNTIME_UNAVAILABLE' }, cursor: null },
    ])
      expect(isLiveRuntimeUnavailable(response)).toBe(false);
  });
});

describe('native acceptance cold primary fault', () => {
  it('kills only the owned primary and leaves its exact proxy running', async () => {
    let containers = [primary, proxy];
    const executeDocker: DockerCommandExecutor = vi.fn(async args => {
      if (args[0] === 'ps')
        return {
          stdout: containers.map(item => `${item.id}\t${item.name}\t${item.image}`).join('\n'),
        };
      if (args[0] === 'kill' && args[1] === primary.id) {
        containers = [proxy];
        return { stdout: primary.id };
      }
      throw new Error(`Unexpected Docker command ${args.join(' ')}`);
    });

    await expect(injectColdPrimaryFault(primary, executeDocker)).resolves.toEqual(proxy);
    expect(executeDocker).toHaveBeenCalledWith(['kill', primary.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', proxy.id]);
  });

  it('refuses to inject a fault after the owned primary identity changes', async () => {
    const executeDocker: DockerCommandExecutor = vi.fn(async () => ({
      stdout: `replacement\t${primary.name}\t${primary.image}`,
    }));
    await expect(injectColdPrimaryFault(primary, executeDocker)).rejects.toThrow(
      'owned primary identity changed'
    );
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', primary.id]);
  });

  it('refuses to kill a primary whose networking proxy is already absent', async () => {
    const executeDocker: DockerCommandExecutor = vi.fn(async () => ({
      stdout: `${primary.id}\t${primary.name}\t${primary.image}`,
    }));
    await expect(injectColdPrimaryFault(primary, executeDocker)).rejects.toThrow(
      'networking proxy was not found'
    );
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', primary.id]);
  });

  it('rejects a same-name replacement primary during cold reads', () => {
    expect(() =>
      assertColdRuntimeUnchanged([{ ...primary, id: 'replacement' }, proxy], primary, proxy)
    ).toThrow('cold reads woke the sandbox');
  });

  it('rejects a lost or replaced networking proxy', () => {
    expect(() => assertColdRuntimeUnchanged([], primary, proxy)).toThrow('networking proxy');
    expect(() =>
      assertColdRuntimeUnchanged([{ ...proxy, id: 'replacement-proxy' }], primary, proxy)
    ).toThrow('networking proxy');
  });
});

describe('cold native SSE persisted snapshot', () => {
  it('matches the persisted transcript before a complete root-scoped fence', () => {
    expect(assertColdNativeSnapshot(snapshot, sessionID, transcript)).toEqual(fence);
  });

  it('reconciles materialized part rewrites and removals before comparing', () => {
    const replay = [
      ...snapshot.slice(0, -1),
      {
        type: 'message.part.updated',
        properties: { part: { ...part, text: 'obsolete answer' } },
      },
      { type: 'message.part.updated', properties: { part } },
      {
        type: 'message.part.updated',
        properties: { part: { ...part, id: 'removed-part', text: 'removed' } },
      },
      { type: 'message.part.removed', properties: { sessionID, partID: 'removed-part' } },
      fence,
    ];
    expect(assertColdNativeSnapshot(replay, sessionID, transcript)).toEqual(fence);
  });

  it('does not accept transcript parts that arrive only after the fence', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [snapshot[0], snapshot[1], fence, snapshot[2]],
        sessionID,
        transcript
      )
    ).toThrow();
  });

  it('rejects an incomplete or other-session fence', () => {
    for (const properties of [
      { ...fence.properties, snapshotComplete: false },
      { ...fence.properties, sessionID: 'ses_other' },
    ]) {
      expect(() =>
        assertColdNativeSnapshot(
          [...snapshot.slice(0, -1), { ...fence, properties }],
          sessionID,
          transcript
        )
      ).toThrow();
    }
  });

  it('rejects missing or changed persisted text', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [
          snapshot[0],
          snapshot[1],
          { type: 'message.part.updated', properties: { part: { ...part, text: 'changed' } } },
          fence,
        ],
        sessionID,
        transcript
      )
    ).toThrow();
  });

  it('rejects missing or differing completion timestamps rather than masking async persistence defects', () => {
    for (const time of [{ created: 2 }, { created: 2, completed: 4 }]) {
      expect(() =>
        assertColdNativeSnapshot(
          [
            snapshot[0],
            { type: 'message.updated', properties: { info: { ...assistant, time } } },
            snapshot[2],
            fence,
          ],
          sessionID,
          transcript
        )
      ).toThrow();
    }
  });

  it('rejects another session message even when the fence selects the owned root', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [
          ...snapshot.slice(0, -1),
          {
            type: 'message.updated',
            properties: { info: { ...user, id: 'other-user', sessionID: 'ses_other' } },
          },
          fence,
        ],
        sessionID,
        transcript
      )
    ).toThrow('cold SSE leaked another session');
  });
});

describe('native burst live transcript validation', () => {
  const expectedText = 'abcdef';
  const burstPart = { ...part, text: expectedText };
  const persisted = { info: assistant, parts: [burstPart] };
  const update = (text: string) => ({
    type: 'message.part.updated',
    properties: { sessionID, part: { ...burstPart, text } },
  });
  const delta = (text: string) => ({
    type: 'message.part.delta',
    properties: {
      sessionID,
      messageID: assistant.id,
      partID: part.id,
      field: 'text',
      delta: text,
    },
  });
  const complete = { type: 'message.updated', properties: { sessionID, info: assistant } };
  const burst = () => [
    {
      type: 'message.updated',
      properties: { sessionID, info: { ...assistant, time: { created: 2 } } },
    },
    update(''),
    delta('ab'),
    update('ab'),
    delta('cd'),
    update('abcd'),
    delta('ef'),
    update(expectedText),
    complete,
  ];
  const validate = (events: Parameters<typeof assertNativeBurst>[0]) =>
    assertNativeBurst(events, sessionID, user.id, persisted, expectedText);

  it('assembles successive deltas and stable-ID full updates into the exact persisted text', () => {
    expect(validate(burst())).toEqual({
      messageID: assistant.id,
      partID: part.id,
      text: expectedText,
      deltaCount: 3,
      partUpdateCount: 4,
      updates: [
        { type: 'message.part.updated', text: '' },
        { type: 'message.part.delta', text: 'ab' },
        { type: 'message.part.updated', text: 'ab' },
        { type: 'message.part.delta', text: 'cd' },
        { type: 'message.part.updated', text: 'abcd' },
        { type: 'message.part.delta', text: 'ef' },
        { type: 'message.part.updated', text: expectedText },
      ],
    });
  });

  it('allows coalesced deltas and extra materialized updates without pinning an event count', () => {
    const events = [
      update(''),
      delta('abcd'),
      update('abcd'),
      delta('ef'),
      update(expectedText),
      update(expectedText),
      complete,
    ];
    expect(validate(events).text).toBe(expectedText);
    expect(validate(events).deltaCount).toBe(2);
    expect(validate(events).partUpdateCount).toBe(4);
  });

  it('does not let a final full update hide a missing middle or final delta', () => {
    for (const index of [4, 6]) {
      const events = burst();
      events.splice(index, 1);
      expect(() => validate(events)).toThrow(/burst delta|burst lost deltas/);
    }
  });

  it('rejects duplicated and reordered deltas even when final materialized text is correct', () => {
    const duplicate = burst();
    duplicate.splice(3, 0, delta('ab'));
    expect(() => validate(duplicate)).toThrow('burst delta duplicated, missing, or out of order');
    const reordered = burst();
    [reordered[2], reordered[4]] = [reordered[4], reordered[2]];
    expect(() => validate(reordered)).toThrow('burst delta duplicated, missing, or out of order');
  });

  it('rejects regressing full updates and a missing final full part despite complete deltas', () => {
    const regression = burst();
    regression.splice(6, 0, update('ab'));
    expect(() => validate(regression)).toThrow('burst full updates arrived out of order');
    const missing = burst();
    missing.splice(7, 1);
    expect(() => validate(missing)).toThrow('burst final text part update was missing');
  });

  it('detects stale deltas delivered after the final full update during live assembly', () => {
    const stale = [update(''), delta('ab'), update(expectedText), delta('cdef'), complete];
    expect(() => validate(stale)).toThrow('burst delta corrupted live assembled text');
    const repaired = [...stale.slice(0, -1), update(expectedText), complete];
    expect(() => validate(repaired)).toThrow('burst delta corrupted live assembled text');
  });

  it('rejects a full update that rolls back live deltas even if later updates repair it', () => {
    const events = burst();
    events.splice(3, 0, update(''));
    expect(() => validate(events)).toThrow('burst full update regressed live assembled text');
  });

  it('requires both native delta delivery and a live completion matching persisted time', () => {
    expect(() => validate([update(expectedText), complete])).toThrow(
      'successive native text deltas'
    );
    expect(() =>
      validate([update(''), delta(expectedText), update(expectedText), complete])
    ).toThrow('successive native text deltas');
    expect(() => validate(burst().slice(0, -1))).toThrow('burst live completion differs');
    expect(() =>
      validate([
        ...burst().slice(0, -1),
        {
          ...complete,
          properties: { sessionID, info: { ...assistant, time: { created: 2, completed: 4 } } },
        },
      ])
    ).toThrow('burst live completion differs');
  });

  it('rejects another correlated assistant and changed text part identities', () => {
    for (const event of [
      { ...complete, properties: { sessionID, info: { ...assistant, id: 'other-assistant' } } },
      {
        type: 'message.part.updated',
        properties: { sessionID, part: { ...burstPart, id: 'other-part' } },
      },
      {
        type: 'message.part.delta',
        properties: { ...delta('ab').properties, partID: 'other-part' },
      },
      {
        type: 'message.part.delta',
        properties: { ...delta('ab').properties, messageID: 'other-assistant' },
      },
    ]) {
      expect(() => validate([...burst(), event])).toThrow();
    }
  });

  it('rejects malformed and other-session matching updates instead of silently coercing data', () => {
    for (const event of [
      { type: 'message.part.delta', properties: { ...delta('ab').properties, delta: 1 } },
      { type: 'message.part.delta', properties: { ...delta('ab').properties, delta: '' } },
      { type: 'message.part.delta', properties: { ...delta('ab').properties, field: 'reasoning' } },
      {
        type: 'message.part.delta',
        properties: { ...delta('ab').properties, sessionID: 'ses_other' },
      },
      { type: 'message.part.updated', properties: { sessionID, part: { ...burstPart, text: 1 } } },
      {
        type: 'message.part.updated',
        properties: { sessionID, part: { ...burstPart, sessionID: 'ses_other' } },
      },
      { ...complete, properties: { sessionID, info: { ...assistant, sessionID: 'ses_other' } } },
    ]) {
      expect(() => validate([...burst(), event])).toThrow();
    }
  });

  it('rejects resnapshot, repeated fence, and removal of the burst message or part', () => {
    for (const event of [
      { type: 'kilo.native.resnapshot', properties: { sessionID, reason: 'overflow' } },
      fence,
      { type: 'message.removed', properties: { sessionID, messageID: assistant.id } },
      { type: 'message.part.removed', properties: { sessionID, partID: part.id } },
    ]) {
      expect(() => validate([...burst(), event])).toThrow();
    }
  });

  it('rejects duplicated persisted text parts and a wrong final persisted transcript', () => {
    for (const entry of [
      { ...persisted, parts: [burstPart, burstPart] },
      { ...persisted, parts: [{ ...burstPart, text: 'changed' }] },
      { ...persisted, info: { ...assistant, parentID: 'other-user' } },
    ]) {
      expect(() => assertNativeBurst(burst(), sessionID, user.id, entry, expectedText)).toThrow();
    }
    expect(() =>
      assertNativeBurst(burst(), sessionID, user.id, persisted, 'x'.repeat(20 * 1024 + 1))
    ).toThrow();
  });

  it('ignores unrelated turns, native non-text parts, and transient lifecycle text', () => {
    const unrelated = [
      {
        ...complete,
        properties: {
          sessionID: 'ses_other',
          info: { ...assistant, id: 'unrelated', parentID: 'other-user' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID,
          part: {
            ...burstPart,
            id: 'lifecycle',
            text: 'working',
            metadata: { 'kilocode.lifecycle': 'transient' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID,
          part: { id: 'step-start', sessionID, messageID: assistant.id, type: 'step-start' },
        },
      },
    ];
    expect(validate([...unrelated, ...burst()])).toEqual(validate(burst()));
  });
});

describe('native burst deterministic fake fixture', () => {
  afterEach(() => vi.useRealTimers());

  it('generates 160 indexed chunks paced across 1.59s within a 20KiB bound using the unchanged fake core', async () => {
    vi.useFakeTimers();
    const directive = parseDirective(nativeBurstFixture.prompt);
    expect(directive?.scenario).toBe('slow');
    expect(directive?.args).toEqual(['160:10:64']);
    expect(directive).not.toBeNull();
    if (!directive) throw new Error('missing burst directive');
    const handler = scenarioRegistry[directive.scenario];
    expect(handler).toBeDefined();
    if (!handler) throw new Error('unsupported burst directive');
    const chunks: string[] = [];
    const done = vi.fn();
    const end = vi.fn();
    const emit: FakeLlmEmit = {
      start: vi.fn(),
      sse(value) {
        const chunk = value as { choices: Array<{ delta: { content?: string } }> };
        const content = chunk.choices[0].delta.content;
        if (content) chunks.push(content);
      },
      done,
      json: vi.fn(),
      empty: vi.fn(),
      fail: vi.fn(),
      end,
      isStarted: () => true,
      onClose: vi.fn(),
    };
    const started = Date.now();
    const result = handler(directive.args, {
      emit,
      id: 'burst-fixture',
      model: 'fake-deterministic',
      state: createFakeLlmState(),
      body: {},
      tools: [],
      reqLogId: 1,
    });
    await vi.runAllTimersAsync();
    await result;
    expect(Date.now() - started).toBe(1590);
    expect(chunks).toHaveLength(160);
    expect(chunks.join('')).toBe(nativeBurstFixture.text);
    expect(Buffer.byteLength(nativeBurstFixture.text)).toBe(10 * 1024);
    expect(done).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
