import { kilo2AssetKey, readKilo2Messages } from './kilo2-source-messages';
import { applyNativeEvent, applyNativeSessionEvent } from './native-conversation-reducer';
import { readNativeConversation, reduceNativePendingRequests } from './native-conversation-source';
import type { NativeEvent, NativeSessionState } from './native-sync';
import type { NativeSnapshotMessage } from './native-sync-snapshot';

const session = {
  id: 'ses_native',
  origin: { directory: '/owned/project' },
  agent: 'build',
  model: { id: 'model', providerID: 'kilo' },
  time: { created: 1, updated: 2 },
};
const state: NativeSessionState = {
  session,
  snapshot: { position: 1, revision: 1 },
  messages: [],
  connection: 'connected',
  runnerConnected: true,
  events: [],
  pending: { permissions: [], questions: [] },
  commands: {},
};
function frame(type: string, data: Record<string, unknown>, seq = 10): NativeEvent {
  return {
    v: 1,
    channel: 'events',
    seq,
    from: 'runner',
    at: seq + 100,
    type,
    body: {
      syncPosition: seq,
      data: {
        id: `evt_${seq}`,
        created: seq,
        type,
        metadata: { trace: { retained: true } },
        data: { sessionID: session.id, ...data },
      },
    },
  };
}
function start(messages: NativeSnapshotMessage[] = []) {
  return applyNativeEvent(
    messages,
    frame('session.step.started', {
      assistantMessageID: 'msg_answer',
      started: 4,
      agent: 'plan',
      model: { providerID: 'vendor', id: 'model', variant: 'high', metadata: { raw: true } },
    })
  );
}

test('native snapshots use the exact Cloud projector for files, errors, costs, metadata and message order', () => {
  const messages: NativeSnapshotMessage[] = [
    {
      seq: 1,
      message: {
        id: 'msg_user',
        type: 'user',
        text: 'Read this',
        time: { created: 1 },
        metadata: { nested: { private: 'retained' } },
        files: [
          { mime: 'image/png', data: 'aW1hZ2U=', name: 'inline.png', source: { type: 'inline' } },
          {
            mime: 'text/plain',
            data: '',
            name: 'uri.txt',
            source: { type: 'uri', uri: 'https://example.test/file.txt' },
          },
        ],
      },
    },
    {
      seq: 2,
      message: {
        id: 'msg_answer',
        type: 'assistant',
        time: { created: 2, completed: 3 },
        cost: 1.25,
        tokens: { input: 4, output: 5, reasoning: 6, cache: { read: 7, write: 8 } },
        error: { type: 'provider.error', message: 'Specific provider failure' },
        content: [
          {
            type: 'reasoning',
            text: 'Considering',
            time: { created: 2, completed: 3 },
            native: { nested: ['kept'] },
          },
          {
            type: 'tool',
            id: 'call',
            name: 'shell',
            state: {
              status: 'error',
              input: { command: 'false' },
              error: { type: 'tool.error', message: 'Exit code 1' },
              metadata: { retained: { exact: true } },
            },
          },
          { type: 'text', text: 'Failed' },
        ],
      },
    },
  ];
  const result = readNativeConversation({ ...state, messages });
  expect(result.nativeMessages).toBe(messages);
  expect(result.session).toBe(session);
  expect(result.messages).toEqual(
    readKilo2Messages(
      { ...session, location: { directory: session.origin.directory } },
      messages.map(item => item.message)
    )
  );
  expect(result.messages.map(item => item.info.id)).toEqual(['msg_user', 'msg_answer']);
  expect(result.messages[0]?.parts).toMatchObject([
    { type: 'text' },
    { type: 'file', url: 'data:image/png;base64,aW1hZ2U=' },
    { type: 'file', url: 'https://example.test/file.txt' },
  ]);
  expect(result.messages[1]?.info).toMatchObject({
    cost: 1.25,
    tokens: messages[1]?.message.tokens,
    error: { data: { message: 'Specific provider failure' } },
    parentID: 'msg_user',
  });
  expect(result.messages[1]?.parts[1]).toMatchObject({
    type: 'tool',
    tool: 'bash',
    state: { status: 'error', error: 'Exit code 1' },
  });
});

test('live per-kind ordinals preserve interleaved text/reasoning/tools, terminal metadata and completion', () => {
  let messages = start();
  const apply = (type: string, data: Record<string, unknown>, seq: number) => {
    messages = applyNativeEvent(
      messages,
      frame(type, { assistantMessageID: 'msg_answer', ...data }, seq)
    );
  };
  apply('session.reasoning.started', { ordinal: 0, native: { thinking: 'first' } }, 11);
  apply('session.reasoning.delta', { ordinal: 0, delta: 'think' }, 12);
  apply(
    'session.reasoning.ended',
    { ordinal: 0, text: 'thinking', native: { thinking: 'complete' } },
    13
  );
  apply('session.text.started', { ordinal: 0 }, 14);
  apply('session.text.delta', { ordinal: 0, delta: 'Before' }, 15);
  apply('session.tool.input.started', { id: 'call', name: 'shell' }, 16);
  apply('session.tool.input.delta', { id: 'call', delta: '{"command":' }, 17);
  expect(readNativeConversation({ ...state, messages }).messages[0]?.parts[2]).toMatchObject({
    type: 'tool',
    state: { status: 'pending', raw: '{"command":' },
  });
  apply('session.tool.input.ended', { id: 'call', text: '{"command":"pwd"}' }, 18);
  apply(
    'session.tool.called',
    { id: 'call', input: { command: 'pwd' }, executed: true, native: { call: { token: 'kept' } } },
    19
  );
  apply(
    'session.tool.progress',
    { id: 'call', metadata: { ephemeral: 'must not leak into terminal state' } },
    20
  );
  apply(
    'session.tool.success',
    {
      id: 'call',
      executed: false,
      content: [
        { type: 'text', text: '/owned/project' },
        { type: 'file', mime: 'image/png', uri: 'data:image/png;base64,cmF3LWZpbGU=' },
      ],
      metadata: { terminal: 'authoritative' },
      native: { result: { kept: true } },
    },
    21
  );
  apply('session.text.started', { ordinal: 1 }, 22);
  apply('session.text.ended', { ordinal: 1, text: 'After', native: { final: 'raw' } }, 23);
  const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } };
  apply(
    'session.step.ended',
    {
      finish: 'stop',
      rawFinish: 'native-stop',
      native: { response: { raw: 'kept' } },
      cost: 1.5,
      tokens,
      snapshot: 'snapshot-end',
    },
    24
  );
  const canonical = messages[0]?.message;
  expect(canonical).toMatchObject({
    time: { created: 4, completed: 24 },
    cost: 1.5,
    tokens,
    rawFinish: 'native-stop',
    native: { response: { raw: 'kept' } },
    metadata: { trace: { retained: true } },
    model: { metadata: { raw: true } },
  });
  expect(canonical?.content?.map(part => part.type)).toEqual(['reasoning', 'text', 'tool', 'text']);
  expect(canonical?.content?.[2]).toMatchObject({
    executed: true,
    time: { created: 16, ran: 19, completed: 21 },
    native: { call: { token: 'kept' }, result: { kept: true } },
    state: {
      status: 'completed',
      metadata: { terminal: 'authoritative' },
      content: [{ type: 'text' }, { type: 'file', uri: 'data:image/png;base64,cmF3LWZpbGU=' }],
    },
  });
  expect(canonical?.content?.[2]?.state?.metadata).not.toHaveProperty('ephemeral');
  const display = readNativeConversation({ ...state, messages }).messages[0];
  expect(display?.parts.map(part => part.type)).toEqual([
    'reasoning',
    'text',
    'tool',
    'file',
    'text',
  ]);
  expect(display?.parts[3]).toMatchObject({
    type: 'file',
    mime: 'image/png',
    url: 'data:image/png;base64,cmF3LWZpbGU=',
  });
  expect(display?.info).toMatchObject({ time: { created: 4, completed: 24 }, cost: 1.5, tokens });
});

test('failed tools and messages retain errors and retry restart clears only native reset fields', () => {
  let messages = start();
  messages = applyNativeEvent(
    messages,
    frame(
      'session.tool.input.started',
      { assistantMessageID: 'msg_answer', id: 'call', name: 'shell' },
      11
    )
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.tool.failed',
      {
        assistantMessageID: 'msg_answer',
        id: 'call',
        executed: false,
        error: { type: 'denied', message: 'Permission denied' },
        content: [{ type: 'text', text: 'denial detail' }],
        metadata: { terminal: true },
      },
      12
    )
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.step.failed',
      {
        assistantMessageID: 'msg_answer',
        error: { type: 'provider.error', message: 'Provider unavailable', status: 503 },
        native: { details: 'preserved' },
      },
      13
    )
  );
  expect(readNativeConversation({ ...state, messages }).messages[0]).toMatchObject({
    info: { error: { data: { message: 'Provider unavailable' } }, time: { completed: 13 } },
    parts: [{ type: 'tool', state: { status: 'error', error: 'Permission denied' } }],
  });
  const restarted = start(messages)[0]?.message;
  expect(restarted?.error).toBeUndefined();
  expect(restarted?.time.completed).toBeUndefined();
  expect(restarted?.content?.[0]?.state?.error?.message).toBe('Permission denied');
});

test('incomplete native values never become a complete empty transcript and resets/errors remain visible', () => {
  const messages = start().map(item => ({ ...item, incomplete: true }));
  const before = readNativeConversation({ ...state, messages });
  expect(before.messages).toEqual([]);
  expect(before.incompleteMessageIDs).toEqual(['msg_answer']);
  expect(before.error).toContain('incomplete');
  const after = applyNativeEvent(
    messages,
    frame('session.message.content.updated', {
      messageID: 'msg_answer',
      content: [{ type: 'text', text: 'Partial but not proved complete' }],
    })
  );
  expect(readNativeConversation({ ...state, messages: after }).incompleteMessageIDs).toEqual([
    'msg_answer',
  ]);
  expect(readNativeConversation({ ...state, messages, error: 'Replay reset required' }).error).toBe(
    'Replay reset required'
  );
  expect(readNativeConversation({ ...state, session: undefined }).error).toContain(
    'no session metadata'
  );
  expect(
    readNativeConversation({ ...state, connection: 'disconnected', error: 'forbidden' }).error
  ).toBe('forbidden');
});

test('authoritative content replacement retains metadata and resets only obsolete source ordinals', () => {
  const messages = start().map(item => ({ ...item, partOrdinals: [2, 10] }));
  const replaced = applyNativeEvent(
    messages,
    frame('session.message.content.updated', {
      messageID: 'msg_answer',
      content: [{ type: 'text', text: 'replacement' }],
    })
  );
  const delta = applyNativeEvent(
    replaced,
    frame('session.text.delta', { assistantMessageID: 'msg_answer', ordinal: 0, delta: '!' })
  );
  expect(delta[0]?.message.content?.[0]?.text).toBe('replacement!');
  expect(delta[0]?.message['metadata']).toEqual(messages[0]?.message['metadata']);
  expect(delta[0]?.partOrdinals).toBeUndefined();
});

test('pending inventory, full permission/form metadata and settlements survive arbitrarily many diagnostic events', () => {
  let pending = reduceNativePendingRequests(state.pending, {
    ...frame('remote.state', {}),
    body: {
      pending: {
        permissions: [
          { requestID: 'existing', tool: 'shell', summary: 'Run tests', extra: { kept: true } },
        ],
        questions: [],
      },
    },
  });
  pending = reduceNativePendingRequests(
    pending,
    frame('permission.asked', {
      id: 'live',
      action: 'edit',
      resources: ['file'],
      metadata: { source: { kept: true } },
    })
  );
  pending = reduceNativePendingRequests(
    pending,
    frame('form.created', {
      form: {
        id: 'question',
        title: 'Choose',
        metadata: { kind: 'question', tool: { id: 'call', messageID: 'msg_answer' } },
        fields: [{ type: 'string', key: 'q', custom: true, metadata: { kept: true } }],
      },
    })
  );
  pending = reduceNativePendingRequests(
    pending,
    frame('permission.replied', { requestID: 'existing' })
  );
  for (let index = 0; index < 1000; index++)
    pending = reduceNativePendingRequests(
      pending,
      frame('session.text.delta', { delta: 'text' }, index)
    );
  expect(pending.permissions).toMatchObject([{ id: 'live', metadata: { source: { kept: true } } }]);
  expect(pending.questions).toMatchObject([
    { id: 'question', metadata: { tool: { id: 'call' } }, fields: [{ metadata: { kept: true } }] },
  ]);
  pending = reduceNativePendingRequests(pending, frame('form.cancelled', { id: 'question' }));
  expect(pending.questions).toEqual([]);
  pending = reduceNativePendingRequests(pending, {
    ...frame('remote.state', {}),
    body: { pending: { permissions: [], questions: [] } },
  });
  expect(pending).toEqual({ permissions: [], questions: [] });
});

test.each([null, {}, { pending: null }, { pending: { permissions: [] } }])(
  'clears stale controls when authoritative inventory is unreadable: %j',
  body => {
    const pending = {
      permissions: [{ id: 'stale', action: 'edit', resources: ['file'] }],
      questions: [{ id: 'stale-question', metadata: { kind: 'question' as const }, fields: [] }],
    };
    expect(reduceNativePendingRequests(pending, { ...frame('remote.state', {}), body })).toEqual({
      permissions: [],
      questions: [],
    });
  }
);

test('ignores a malformed live permission without losing valid pending requests', () => {
  const pending = {
    permissions: [{ id: 'current', action: 'edit', resources: ['file'] }],
    questions: [],
  };
  expect(
    reduceNativePendingRequests(pending, frame('permission.asked', { id: 'invalid' }))
  ).toEqual(pending);
});

test('native live reduction shares untouched content, ignores late deltas and flags missing ordinals', () => {
  const messages: NativeSnapshotMessage[] = [
    {
      seq: 1,
      message: {
        id: 'msg_answer',
        type: 'assistant',
        time: { created: 1 },
        content: [
          { type: 'text', text: 'untouched' },
          { type: 'tool', id: 'call', name: 'shell', state: { status: 'streaming', input: 'old' } },
        ],
      },
    },
  ];
  const updated = applyNativeEvent(
    messages,
    frame('session.tool.input.delta', {
      assistantMessageID: 'msg_answer',
      id: 'call',
      delta: ' new',
    })
  );
  expect(updated[0]?.message.content?.[0]).toBe(messages[0]?.message.content?.[0]);
  expect(updated[0]?.message.content?.[1]?.state).toMatchObject({
    status: 'streaming',
    input: 'old new',
  });
  expect(messages[0]?.message.content?.[1]?.state?.input).toBe('old');
  const completed = updated.map(item => ({
    ...item,
    message: { ...item.message, time: { ...item.message.time, completed: 10 } },
  }));
  expect(
    applyNativeEvent(
      completed,
      frame('session.text.delta', {
        assistantMessageID: 'msg_answer',
        ordinal: 0,
        delta: 'duplicate',
      })
    )[0]
  ).toBe(completed[0]);
  const missing = applyNativeEvent(
    updated,
    frame('session.text.delta', {
      assistantMessageID: 'msg_answer',
      ordinal: 3,
      delta: 'missing predecessor',
    })
  );
  expect(missing[0]?.incomplete).toBe(true);
  expect(readNativeConversation({ ...state, messages: missing }).error).toContain('incomplete');
});

test('a socket handshake is still loading until its native snapshot read completes', () => {
  expect(
    readNativeConversation({ ...state, snapshot: undefined, session: undefined }).loading
  ).toBe(true);
  expect(
    readNativeConversation({ ...state, snapshot: undefined, session: undefined }).error
  ).toBeUndefined();
  expect(readNativeConversation({ ...state, messages: [] }).loading).toBe(false);
});

test('native inbox files and synthetic messages retain exact payloads and delivery order', () => {
  const files = [
    {
      mime: 'text/plain',
      data: 'ZmlsZQ==',
      name: 'file.txt',
      source: { type: 'inline' },
      metadata: { exact: true },
    },
  ];
  let messages = applyNativeEvent(
    [],
    frame(
      'session.inbox.enqueued',
      {
        inboxID: 'msg_user',
        item: {
          type: 'user',
          payload: { text: 'Original', files, metadata: { nested: 'retained' } },
        },
      },
      1
    )
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.inbox.enqueued',
      {
        inboxID: 'msg_user',
        item: {
          type: 'user',
          payload: { text: 'Authoritative echo', files, metadata: { nested: 'retained' } },
        },
      },
      2
    )
  );
  messages = applyNativeEvent(
    messages,
    frame(
      'session.inbox.enqueued',
      {
        inboxID: 'msg_synthetic',
        item: {
          type: 'synthetic',
          payload: {
            text: 'Context',
            description: 'Exact description',
            metadata: { source: 'native' },
          },
        },
      },
      3
    )
  );
  expect(messages).toHaveLength(2);
  expect(messages[0]?.message).toMatchObject({
    text: 'Authoritative echo',
    files,
    metadata: { nested: 'retained' },
  });
  messages = applyNativeEvent(
    messages,
    frame('session.inbox.delivered', { inboxID: 'msg_user' }, 4)
  );
  expect(messages.map(item => item.message.id)).toEqual(['msg_synthetic', 'msg_user']);
  expect(messages[1]?.message.time.created).toBe(4);
  messages = applyNativeEvent(
    messages,
    frame('session.inbox.cancelled', { inboxID: 'msg_synthetic' }, 5)
  );
  expect(messages.map(item => item.message.id)).toEqual(['msg_user']);
  expect(readNativeConversation({ ...state, messages }).messages[0]?.parts[1]).toMatchObject({
    type: 'file',
    filename: 'file.txt',
  });
});

test('native session model and metadata changes preserve complete values, replacing removed metadata keys', () => {
  const model = {
    id: 'next',
    providerID: 'vendor',
    variant: 'high',
    native: { exact: ['preserved'] },
  };
  const changed = applyNativeSessionEvent(session, frame('session.model.selected', { model }));
  expect(changed?.model).toEqual(model);
  const initial = applyNativeSessionEvent(
    changed,
    frame('session.metadata.updated', { metadata: { removed: 'old', nested: { exact: true } } })
  );
  const replaced = applyNativeSessionEvent(
    initial,
    frame('session.metadata.updated', { metadata: { nested: { exact: 'new' } } })
  );
  expect(replaced?.['metadata']).toEqual({ nested: { exact: 'new' } });
  const pendingMove = readNativeConversation({ ...state, pendingSnapshotMessageIDs: ['msg_move'] });
  expect(pendingMove.incompleteMessageIDs).toEqual(['msg_move']);
  expect(pendingMove.error).toContain('incomplete');
});

test('unresolved live media stays explicit without hiding other messages or crashing the renderer', () => {
  const uri = `media:${'a'.repeat(64)}`;
  const messages: NativeSnapshotMessage[] = [
    {
      seq: 1,
      message: {
        id: 'msg_media',
        type: 'user',
        time: { created: 1 },
        text: 'Image',
        files: [{ uri, mime: 'image/png', source: { type: 'inline' } }],
      },
    },
    {
      seq: 2,
      message: {
        id: 'msg_other',
        type: 'assistant',
        time: { created: 2 },
        content: [{ type: 'text', text: 'Other readable content' }],
      },
    },
  ];
  const unresolved = readNativeConversation({ ...state, messages });
  expect(unresolved.incompleteMessageIDs).toEqual(['msg_media']);
  expect(unresolved.error).toContain('incomplete');
  expect(unresolved.messages.map(item => item.info.id)).toEqual(['msg_other']);
  const bytes = 'data:image/png;base64,aW1hZ2U=';
  const resolved = readNativeConversation({
    ...state,
    messages,
    assetURLs: { [kilo2AssetKey('msg_media_000001', uri, 'image/png')]: bytes },
  });
  expect(resolved.error).toBeUndefined();
  expect(resolved.messages[0]?.parts[1]).toMatchObject({ type: 'file', url: bytes });
  expect(resolved.nativeMessages[0]?.message.files?.[0]).toEqual({
    uri,
    mime: 'image/png',
    source: { type: 'inline' },
  });
  const changed = messages.map(item =>
    item.message.id !== 'msg_media'
      ? item
      : {
          ...item,
          message: {
            ...item.message,
            files: [
              {
                uri: `media:${'b'.repeat(64)}`,
                mime: 'image/png',
                source: { type: 'inline' as const },
              },
            ],
          },
        }
  );
  expect(
    readNativeConversation({
      ...state,
      messages: changed,
      assetURLs: { [kilo2AssetKey('msg_media_000001', uri, 'image/png')]: bytes },
    }).incompleteMessageIDs
  ).toEqual(['msg_media']);
});

test.each<[string, Record<string, unknown>]>([
  ['session.text.delta', { assistantMessageID: 'msg_answer', delta: 12 }],
  ['session.tool.called', { assistantMessageID: 'msg_answer', id: 'call', input: {} }],
  ['session.message.content.updated', { messageID: 'msg_answer', content: 'not an array' }],
  ['session.metadata.updated', { metadata: null }],
])('rejects malformed relevant native %s data at the boundary', (type, data) => {
  expect(() => applyNativeEvent([], frame(type, data))).toThrow();
});

test('malformed native envelopes fail explicitly while unrelated event no-ops remain legitimate', () => {
  const messages = start();
  expect(() =>
    applyNativeEvent(messages, { ...frame('session.text.delta', {}), body: null })
  ).toThrow();
  expect(() =>
    applyNativeSessionEvent(session, {
      ...frame('session.metadata.updated', {}),
      body: { data: 'invalid' },
    })
  ).toThrow();
  expect(applyNativeEvent(messages, { ...frame('remote.state', {}), body: null })).toBe(messages);
  expect(applyNativeSessionEvent(session, { ...frame('session.status', {}), body: null })).toBe(
    session
  );
});
