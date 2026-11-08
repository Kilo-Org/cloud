import { fetchNativeSnapshot, projectNativeSnapshot } from './native-sync-snapshot';
import { readKilo2Messages, kilo2ToolFileId } from './kilo2-source-messages';
import {
  kilo2MessageSchema,
  kilo2PartId,
  type Kilo2Message,
} from '@kilocode/session-ingest-contracts';

const sessionID = 'ses_native';
const sessionPath = `/v1/sessions/${sessionID}`;
const hash = 'a'.repeat(64);
const nativeSession = {
  id: sessionID,
  origin: { directory: '/workspace' },
  title: 'native',
  time: { created: 1, updated: 2 },
};

function native(id: string, type: string, fields: Record<string, unknown> = {}) {
  return { id, type, time: { created: 1 }, ...fields };
}

function state(revision = 4, position = 20) {
  return {
    version: 1,
    sessionID,
    tenant: { type: 'user', id: 'user_native' },
    deleted: false,
    creatorID: 'user_native',
    sourceID: '00000000-0000-4000-8000-000000000001',
    position,
    revision,
    batches: 1,
    lastReceipt: null,
    usage: { entities: 0, inlineBytes: 0, blobBytes: 0 },
    createdAt: 1,
    updatedAt: 2,
  };
}

function pagePath(revision = 4, cursor?: string) {
  return `${sessionPath}/entities?revision=${revision}&limit=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
}

function page(entities: unknown[], next: string | null = null, revision = 4, position = 20) {
  return { version: 1, sessionID, revision, position, entities, next };
}

function entity(kind: string, id: string, value: unknown, revision = 4) {
  return { kind, id, revision, value };
}

function envelope(count = 2, through = 20) {
  return entity('message', 'msg_assistant', {
    seq: 7,
    message: native('msg_assistant', 'assistant', { native: { opaque: [null, true] } }),
    parts: { count, through },
  });
}

function part(
  ordinal: number,
  position = 19,
  content: unknown = { type: 'text', text: `${ordinal}` }
) {
  return entity('message-part', `msg_assistant/${ordinal}`, {
    messageID: 'msg_assistant',
    ordinal,
    position,
    part: content,
  });
}

type Step = { path: string; body: unknown; status?: number };

function fakeFetch(steps: Step[]) {
  let index = 0;
  const fetch = jest.fn(async (path: string) => {
    const step = steps[index++];
    if (!step) throw new Error(`Unexpected fetch ${path}`);
    expect(path).toBe(step.path);
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(body.error.message), { code: body.error.code });
    }
    return body as T;
  };
  return { fetch, request };
}

function snapshotFetch(entities: unknown[], position = 20) {
  return fakeFetch([
    { path: sessionPath, body: state(4, position) },
    { path: pagePath(), body: page(entities, null, 4, position) },
  ]);
}

function conflict(path: string): Step {
  return {
    path,
    status: 409,
    body: { error: { code: 'revision_changed', message: 'Restart the read' } },
  };
}

describe('fetchNativeSnapshot', () => {
  it('pins every page to state and reconstructs numeric, sparse ordinals across lexical pages', async () => {
    const first = part(2, 10, { type: 'reasoning', text: 'first', native: { nil: null } });
    const last = part(10, 19, { type: 'text', text: 'last' });
    const user = entity('message', 'msg_user', {
      seq: 2,
      message: native('msg_user', 'user', { text: 'hello', files: [] }),
    });
    const session = entity('session', sessionID, nativeSession, 1);
    const cursor = 'opaque+/cursor=';
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([envelope(), user, last], cursor) },
      { path: pagePath(4, cursor), body: page([first, session]) },
    ]);

    const result = await fetchNativeSnapshot(request, sessionID);

    expect(result.position).toBe(20);
    expect(result.revision).toBe(4);
    expect(result.entities).toEqual([envelope(), user, last, first, session]);
    expect(result.messages).toEqual([
      { message: native('msg_user', 'user', { text: 'hello', files: [] }), seq: 2 },
      {
        message: native('msg_assistant', 'assistant', {
          native: { opaque: [null, true] },
          content: [
            { type: 'reasoning', text: 'first', native: { nil: null } },
            { type: 'text', text: 'last' },
          ],
        }),
        seq: 7,
        partOrdinals: [2, 10],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps inline native content and ignores obsolete split parts without an envelope', async () => {
    const content = [{ type: 'text', text: 'inline', native: { nil: null } }];
    const { request } = snapshotFetch([
      entity('message', 'msg_assistant', {
        seq: 0,
        message: native('msg_assistant', 'assistant', { content }),
      }),
      part(2),
    ]);

    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      { message: native('msg_assistant', 'assistant', { content }), seq: 0 },
    ]);
  });

  it('retains non-chat native messages and empty user text', async () => {
    const shell = native('msg_shell', 'shell', { command: 'pwd', status: 'completed' });
    const { request } = snapshotFetch([
      entity('message', 'msg_system', {
        seq: 1,
        message: native('msg_system', 'system', { text: 'instructions' }),
      }),
      entity('message', 'msg_user', {
        seq: 0,
        message: native('msg_user', 'user', { text: '' }),
      }),
      entity('message', 'msg_shell', { seq: 2, message: shell }),
    ]);

    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      { message: native('msg_user', 'user', { text: '' }), seq: 0 },
      { message: native('msg_system', 'system', { text: 'instructions' }), seq: 1 },
      { message: shell, seq: 2 },
    ]);
  });

  it('accepts an explicitly empty envelope only when no parts exist', async () => {
    const { request } = snapshotFetch([envelope(0)]);
    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      {
        message: native('msg_assistant', 'assistant', {
          native: { opaque: [null, true] },
          content: [],
        }),
        seq: 7,
        partOrdinals: [],
      },
    ]);
  });

  it.each<[string, unknown[]]>([
    ['missing part', [envelope(), part(2)]],
    ['extra part', [envelope(1), part(2), part(10)]],
    ['uncaptured frontier', [envelope(2, 21), part(2), part(10)]],
    ['newer part', [envelope(), part(2), part(10, 21)]],
    [
      'deferred part',
      [
        envelope(),
        part(2),
        entity('message-part', 'msg_assistant/10', {
          messageID: 'msg_assistant',
          ordinal: 10,
          position: 19,
          deferred: true,
        }),
      ],
    ],
    [
      'duplicate ordinal',
      [
        envelope(),
        part(2),
        entity('message-part', 'msg_assistant/10', {
          messageID: 'msg_assistant',
          ordinal: 2,
          position: 19,
          part: { type: 'text', text: 'duplicate' },
        }),
      ],
    ],
    ['negative ordinal', [envelope(1), part(-1)]],
    ['fractional ordinal', [envelope(1), part(1.5)]],
    ['negative part position', [envelope(1), part(2, -1)]],
    ['non-object part', [envelope(1), part(2, 19, null)]],
    ['invalid native part', [envelope(1), part(2, 19, { type: 'text', text: 123 })]],
    ['malformed part', [envelope(1), entity('message-part', 'msg_assistant/2', null)]],
    [
      'invalid envelope count',
      [
        entity('message', 'msg_assistant', {
          seq: 7,
          message: native('msg_assistant', 'assistant'),
          parts: { count: 1.5, through: 20 },
        }),
        part(2),
      ],
    ],
    [
      'conflicting inline content',
      [
        entity('message', 'msg_assistant', {
          seq: 7,
          message: native('msg_assistant', 'assistant', { content: [] }),
          parts: { count: 1, through: 20 },
        }),
        part(2),
      ],
    ],
    [
      'assistant missing both content and parts',
      [
        entity('message', 'msg_assistant', {
          seq: 7,
          message: native('msg_assistant', 'assistant'),
        }),
      ],
    ],
  ])(
    'marks %s incomplete without displaying a truncated complete message',
    async (_name, entities) => {
      const { request } = snapshotFetch(entities);
      const result = await fetchNativeSnapshot(request, sessionID);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        message: { id: 'msg_assistant', type: 'assistant' },
        seq: 7,
        incomplete: true,
      });
      expect(result.messages[0]?.partOrdinals).toBeUndefined();
    }
  );

  it('uses the snapshot source position, not transcript sequence or replication revision', async () => {
    const { request } = snapshotFetch([envelope(1, 100), part(2, 99)], 100);
    const result = await fetchNativeSnapshot(request, sessionID);
    expect(result).toMatchObject({ position: 100, revision: 4 });
    expect(result.messages[0]).toEqual({
      message: native('msg_assistant', 'assistant', {
        native: { opaque: [null, true] },
        content: [{ type: 'text', text: '2' }],
      }),
      seq: 7,
      partOrdinals: [2],
    });
  });

  it('resolves blob-valued envelopes and parts while retaining portable references', async () => {
    const partHash = 'b'.repeat(64);
    const messageBlob = {
      kind: 'message',
      id: 'msg_assistant',
      revision: 4,
      blob: { hash, bytes: 100 },
    };
    const partBlob = {
      kind: 'message-part',
      id: 'msg_assistant/10',
      revision: 4,
      blob: { hash: partHash, bytes: 100 },
    };
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([messageBlob, partBlob]) },
      { path: `${sessionPath}/blobs/${hash}`, body: envelope(1).value },
      { path: `${sessionPath}/blobs/${partHash}`, body: part(10).value },
    ]);

    const result = await fetchNativeSnapshot(request, sessionID);
    expect(result.entities).toEqual([messageBlob, partBlob]);
    expect(result.messages).toEqual([
      {
        message: native('msg_assistant', 'assistant', {
          native: { opaque: [null, true] },
          content: [{ type: 'text', text: '10' }],
        }),
        seq: 7,
        partOrdinals: [10],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('fetches shared entity blobs once and does not dereference private asset bytes', async () => {
    const blob = { hash, bytes: 12 };
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      {
        path: pagePath(),
        body: page([
          { kind: 'instruction-blob', id: 'one', revision: 4, blob },
          { kind: 'instruction-blob', id: 'two', revision: 4, blob },
          entity('asset', 'attachment', { blob: { hash: 'c'.repeat(64), bytes: 50 } }),
          {
            kind: 'asset',
            id: 'raw-attachment',
            revision: 4,
            blob: { hash: 'd'.repeat(64), bytes: 50 },
          },
        ]),
      },
      { path: `${sessionPath}/blobs/${hash}`, body: { text: 'instruction' } },
    ]);

    const result = await fetchNativeSnapshot(request, sessionID);
    expect(result.messages).toEqual([]);
    expect(result.entities).toContainEqual({
      kind: 'asset',
      id: 'raw-attachment',
      revision: 4,
      blob: { hash: 'd'.repeat(64), bytes: 50 },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('discards all earlier pages and restarts state on a revision conflict', async () => {
    const obsolete = entity('message', 'msg_old', {
      seq: 0,
      message: native('msg_old', 'user', { text: 'obsolete' }),
    });
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([obsolete], 'next') },
      conflict(pagePath(4, 'next')),
      { path: sessionPath, body: state(5, 21) },
      { path: pagePath(5), body: page([], null, 5, 21) },
    ]);

    expect(await fetchNativeSnapshot(request, sessionID)).toEqual({
      position: 21,
      revision: 5,
      entities: [],
      messages: [],
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('restarts if the first page reports a different revision despite its pin', async () => {
    const { request } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([], null, 5, 21) },
      { path: sessionPath, body: state(5, 21) },
      { path: pagePath(5), body: page([], null, 5, 21) },
    ]);
    expect(await fetchNativeSnapshot(request, sessionID)).toMatchObject({
      revision: 5,
      position: 21,
    });
  });

  it('restarts from current state when an old entity blob was reclaimed', async () => {
    const { request } = fakeFetch([
      { path: sessionPath, body: state() },
      {
        path: pagePath(),
        body: page([
          { kind: 'message', id: 'msg_assistant', revision: 4, blob: { hash, bytes: 100 } },
        ]),
      },
      {
        path: `${sessionPath}/blobs/${hash}`,
        status: 404,
        body: { error: { code: 'blob_not_found', message: 'Superseded blob' } },
      },
      { path: sessionPath, body: state(5, 21) },
      { path: pagePath(5), body: page([], null, 5, 21) },
    ]);
    expect(await fetchNativeSnapshot(request, sessionID)).toMatchObject({
      revision: 5,
      messages: [],
    });
  });

  it('bounds revision restarts to three complete attempts', async () => {
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      conflict(pagePath()),
      { path: sessionPath, body: state() },
      conflict(pagePath()),
      { path: sessionPath, body: state() },
      conflict(pagePath()),
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toMatchObject({
      code: 'revision_changed',
    });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('does not restart unrelated service conflicts', async () => {
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      {
        path: pagePath(),
        status: 409,
        body: { error: { code: 'source_conflict', message: 'Different producer' } },
      },
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toMatchObject({
      code: 'source_conflict',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects deleted state without requesting entities', async () => {
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: { version: 1, sessionID, deleted: true, deletedAt: 2 } },
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toMatchObject({
      code: 'session_deleted',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown[]]>([
    ['unknown entity kind', [entity('unknown', 'item', null)]],
    ['missing value', [{ kind: 'message', id: 'item', revision: 4 }]],
    [
      'conflicting value and blob',
      [{ ...entity('session', 'item', null), blob: { hash, bytes: 10 } }],
    ],
    [
      'invalid blob hash',
      [{ kind: 'session', id: 'item', revision: 4, blob: { hash: 'invalid', bytes: 10 } }],
    ],
    [
      'invalid blob size',
      [{ kind: 'session', id: 'item', revision: 4, blob: { hash, bytes: -1 } }],
    ],
    ['future entity revision', [entity('session', 'item', null, 5)]],
    [
      'duplicate entity identity',
      [entity('session', 'item', null), entity('session', 'item', null)],
    ],
    [
      'native message identity mismatch',
      [
        entity('message', 'wrong', {
          seq: 0,
          message: native('msg_other', 'user', { text: 'no' }),
        }),
      ],
    ],
    [
      'native message missing time',
      [entity('message', 'msg_invalid', { seq: 0, message: { id: 'msg_invalid', type: 'user' } })],
    ],
    [
      'native message invalid file',
      [
        entity('message', 'msg_invalid', {
          seq: 0,
          message: native('msg_invalid', 'user', { files: [{ mime: 'text/plain' }] }),
        }),
      ],
    ],
    ['native session missing origin', [entity('session', sessionID, { id: sessionID })]],
    [
      'native session identity mismatch',
      [entity('session', sessionID, { ...nativeSession, id: 'ses_other' })],
    ],
  ])('rejects %s at the portable boundary', async (_name, entities) => {
    const { request, fetch } = snapshotFetch(entities);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a page source position from a different snapshot', async () => {
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([], null, 4, 21) },
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toThrow(
      'source position mismatch'
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-session pages rather than accepting their transcript', async () => {
    const { request } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: { ...page([]), sessionID: 'ses_other' } },
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toThrow(
      'session identity mismatch'
    );
  });

  it('rejects repeated cursors rather than looping indefinitely', async () => {
    const { request, fetch } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([entity('session', 'one', null)], 'same') },
      { path: pagePath(4, 'same'), body: page([entity('session', 'two', null)], 'same') },
    ]);
    await expect(fetchNativeSnapshot(request, sessionID)).rejects.toThrow('cursor did not advance');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

test('cancels a non-cooperative snapshot request and fences its late continuation', async () => {
  const controller = new AbortController();
  let release: (value: unknown) => void = () => {};
  let signal: AbortSignal | null | undefined;
  const request = jest.fn(<T>(_path: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<T>(resolve => {
      release = value => resolve(value as T);
    });
  });
  const pending = fetchNativeSnapshot(
    request as Parameters<typeof fetchNativeSnapshot>[0],
    sessionID,
    controller.signal
  );
  const rejected = expect(pending).rejects.toThrow('canceled');
  controller.abort();
  await rejected;
  release(state());
  await Promise.resolve();
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

test('the snapshot deadline covers the entire paginated read', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  let reads = 0;
  const request = jest.fn(<T>(path: string, init?: RequestInit) => {
    signal = init?.signal;
    const body =
      path === sessionPath
        ? state()
        : page([entity('instruction-state', `item-${reads}`, null)], String(reads));
    reads++;
    return new Promise<T>(resolve => {
      setTimeout(() => resolve(body as T), 8000);
    });
  });
  try {
    const pending = fetchNativeSnapshot(
      request as Parameters<typeof fetchNativeSnapshot>[0],
      sessionID
    );
    const rejected = expect(pending).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(request).toHaveBeenCalledTimes(15);
    expect(signal?.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(15);
  } finally {
    jest.useRealTimers();
  }
});

test('an already canceled snapshot starts no request', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = jest.fn(<T>() => Promise.resolve(undefined as T));
  await expect(
    fetchNativeSnapshot(
      request as Parameters<typeof fetchNativeSnapshot>[0],
      sessionID,
      controller.signal
    )
  ).rejects.toThrow('canceled');
  expect(request).not.toHaveBeenCalled();
});

test('a stalled request ends at its per-request deadline', async () => {
  jest.useFakeTimers();
  const request = jest.fn(<T>() => new Promise<T>(() => {}));
  try {
    const pending = fetchNativeSnapshot(
      request as Parameters<typeof fetchNativeSnapshot>[0],
      sessionID
    );
    const rejected = expect(pending).rejects.toThrow('request timed out');
    await jest.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('a maximum-size snapshot tolerates 100 milliseconds per serial page', async () => {
  jest.useFakeTimers();
  let start = 0;
  const request = jest.fn(<T>(path: string) => {
    let body: unknown = state();
    if (path !== sessionPath) {
      const entities = Array.from({ length: 100 }, (_, index) =>
        entity('instruction-state', `item-${start + index}`, null)
      );
      start += entities.length;
      body = page(entities, start < 100_000 ? String(start) : null);
    }
    return new Promise<T>(resolve => {
      setTimeout(() => resolve(body as T), 100);
    });
  });
  try {
    const pending = fetchNativeSnapshot(
      request as Parameters<typeof fetchNativeSnapshot>[0],
      sessionID
    );
    await jest.advanceTimersByTimeAsync(100_100);
    expect((await pending).entities).toHaveLength(100_000);
    expect(request).toHaveBeenCalledTimes(1001);
  } finally {
    jest.useRealTimers();
  }
});

describe('canonical native snapshot projection', () => {
  it('preserves full native values and shares the Cloud history projection after reconstruction', async () => {
    const model = { providerID: 'kilo', id: 'native-model', native: { variant: 'opaque' } };
    const session = {
      ...nativeSession,
      origin: { directory: '/workspace', subpath: 'native', projectID: 'project_native' },
      model,
      native: { sessionMetadata: true },
    };
    const projectedSession = { ...session, location: { directory: session.origin.directory } };
    const messages: Kilo2Message[] = [
      {
        id: 'msg_user',
        type: 'user',
        time: { created: 1 },
        text: 'files',
        files: [
          { mime: 'text/plain', name: 'inline.txt', data: 'aGVsbG8=', source: { type: 'inline' } },
          {
            mime: 'image/png',
            name: 'remote.png',
            data: '',
            source: { type: 'uri', uri: 'https://fixture.invalid/image.png' },
          },
        ],
      },
      {
        id: 'msg_assistant',
        type: 'assistant',
        time: { created: 2, completed: 3, native: 'preserved' },
        model,
        agent: 'plan',
        cost: 0.25,
        finish: 'stop',
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        content: [
          { type: 'reasoning', text: 'thinking', time: { created: 2, completed: 3 } },
          { type: 'text', text: 'answer', native: { nested: [null, true] } },
          {
            type: 'tool',
            id: 'tool_shell',
            name: 'shell',
            time: { created: 2, ran: 2, completed: 3 },
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              metadata: { native: true },
              content: [{ type: 'text', text: '/workspace' }],
            },
          },
          {
            type: 'tool',
            id: 'tool_read',
            name: 'read',
            state: {
              status: 'error',
              input: { path: 'missing' },
              error: { type: 'missing', message: 'Not found' },
            },
          },
          {
            type: 'tool',
            id: 'tool_subagent',
            name: 'subagent',
            state: {
              status: 'running',
              input: { agent: 'explore' },
              metadata: { sessionID: 'ses_child' },
            },
          },
        ],
        native: { messageMetadata: 'retained' },
      },
      {
        id: 'msg_compaction',
        type: 'compaction',
        time: { created: 4 },
        status: 'completed',
        summary: 'summary',
        content: [{ type: 'text', text: 'detail' }],
      },
      { id: 'msg_synthetic', type: 'synthetic', time: { created: 5 }, text: 'continue' },
      { id: 'msg_pending', type: 'compaction', time: { created: 6 }, status: 'pending' },
      {
        id: 'msg_aborted',
        type: 'assistant',
        time: { created: 7, completed: 8 },
        content: [],
        error: { type: 'aborted', message: 'Interrupted' },
      },
      { id: 'msg_shell', type: 'shell', time: { created: 9 }, command: 'pwd' },
      { id: 'msg_empty', type: 'user', time: { created: 10 }, text: '' },
    ];
    const entities = messages
      .flatMap((message, seq) => {
        if (message.id !== 'msg_assistant')
          return [entity('message', message.id, { seq, message })];
        const { content = [], ...header } = message;
        return [
          entity('message', message.id, {
            seq,
            message: header,
            parts: { count: content.length, through: 20 },
          }),
          ...content
            .map((part, ordinal) =>
              entity('message-part', `${message.id}/${ordinal * 2}`, {
                messageID: message.id,
                ordinal: ordinal * 2,
                position: 19,
                part,
              })
            )
            .reverse(),
        ];
      })
      .reverse();
    const sessionBlob = { kind: 'session', id: sessionID, revision: 4, blob: { hash, bytes: 100 } };
    const { request } = fakeFetch([
      { path: sessionPath, body: state() },
      { path: pagePath(), body: page([...entities, sessionBlob]) },
      { path: `${sessionPath}/blobs/${hash}`, body: session },
    ]);
    const snapshot = await fetchNativeSnapshot(request, sessionID);
    expect(snapshot.session).toEqual(session);
    expect(snapshot.session).not.toHaveProperty('location');
    expect(snapshot.messages.map(item => item.message)).toEqual(messages);
    expect(snapshot.messages[1]?.partOrdinals).toEqual([0, 2, 4, 6, 8]);
    expect(snapshot.entities).toContainEqual(sessionBlob);

    const projection = projectNativeSnapshot(snapshot);
    expect(projection).toEqual({
      session: projectedSession,
      position: 20,
      revision: 4,
      messages: readKilo2Messages(projectedSession, messages),
      incompleteMessageIDs: [],
    });
    expect(projection.messages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'file', url: 'data:text/plain;base64,aGVsbG8=' }),
        expect.objectContaining({ type: 'file', url: 'https://fixture.invalid/image.png' }),
      ])
    );
    expect(projection.messages[1]?.info).toMatchObject({
      parentID: 'msg_user',
      cost: 0.25,
      tokens: messages[1]?.tokens,
    });
    expect(projection.messages[1]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          tool: 'bash',
          state: expect.objectContaining({ status: 'completed', output: '/workspace' }),
        }),
        expect.objectContaining({
          type: 'tool',
          tool: 'read',
          state: expect.objectContaining({ status: 'error', error: 'Not found' }),
        }),
        expect.objectContaining({
          type: 'tool',
          tool: 'task',
          state: expect.objectContaining({ input: { agent: 'explore', subagent_type: 'explore' } }),
        }),
      ])
    );
    expect(projection.messages[2]?.info).toMatchObject({ summary: true });
    expect(projection.messages[4]?.info).toMatchObject({ error: { name: 'MessageAbortedError' } });
  });

  it('retains incomplete native metadata but does not project it as an empty complete answer', async () => {
    const message = {
      id: 'msg_assistant',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      cost: 0.5,
      native: { retained: true },
      content: [{ type: 'text', text: 'conflicting' }],
    };
    const { request } = snapshotFetch([
      entity('session', sessionID, nativeSession),
      entity('message', message.id, { seq: 1, message, parts: { count: 1, through: 20 } }),
      part(2),
    ]);
    const snapshot = await fetchNativeSnapshot(request, sessionID);
    expect(snapshot.messages).toEqual([{ message, seq: 1, incomplete: true }]);
    expect(projectNativeSnapshot(snapshot)).toMatchObject({
      position: 20,
      revision: 4,
      messages: [],
      incompleteMessageIDs: ['msg_assistant'],
    });
  });

  it('distinguishes an empty uploaded session from absent native session metadata', async () => {
    const missing = snapshotFetch([]);
    const pending = await fetchNativeSnapshot(missing.request, sessionID);
    expect(pending.session).toBeUndefined();
    expect(() => projectNativeSnapshot(pending)).toThrow('no session metadata');
    const empty = snapshotFetch([entity('session', sessionID, nativeSession)]);
    expect(projectNativeSnapshot(await fetchNativeSnapshot(empty.request, sessionID))).toEqual({
      session: { ...nativeSession, location: { directory: nativeSession.origin.directory } },
      position: 20,
      revision: 4,
      messages: [],
      incompleteMessageIDs: [],
    });
  });
});

describe('authorized native snapshot attachments', () => {
  const mediaHash = 'c'.repeat(64);
  const pdfHash = 'd'.repeat(64);
  const storedUser = {
    id: 'msg_media_user',
    type: 'user',
    time: { created: 1 },
    text: 'inspect',
    files: [
      {
        mime: 'image/png',
        name: 'image.png',
        uri: `media:${mediaHash}`,
        source: { type: 'inline' },
      },
    ],
  };
  const userEntity = entity('message', storedUser.id, { seq: 0, message: storedUser });
  function asset(
    id: string,
    kind: string,
    owner: string,
    pointer: string,
    reference: string,
    blobHash: string,
    bytes: number,
    mime: string
  ) {
    return entity('asset', id, {
      entity: { kind, id: owner },
      pointer,
      reference,
      blob: { hash: blobHash, bytes },
      mime,
    });
  }
  const userMapping = asset(
    'user-image',
    'message',
    storedUser.id,
    '/message/files/0',
    `media:${mediaHash}`,
    mediaHash,
    3,
    'image/png'
  );

  it('accepts stored media without invented inline data and resolves exact authorized user/tool positions', async () => {
    const toolPart = {
      type: 'tool',
      id: 'tool_media',
      name: 'read',
      state: {
        status: 'completed',
        input: { path: '/synthetic' },
        content: [
          { type: 'text', text: 'image and document' },
          { type: 'file', mime: 'image/png', name: 'image.png', uri: `media:${mediaHash}` },
          {
            type: 'file',
            mime: 'application/pdf',
            name: 'result.pdf',
            uri: '/synthetic/result.pdf',
          },
          {
            type: 'file',
            mime: 'image/png',
            name: 'inline.png',
            uri: 'data:image/png;base64,BAU=',
          },
        ],
      },
    };
    const assistantID = 'msg_media_assistant';
    const { request } = snapshotFetch([
      entity('session', sessionID, nativeSession),
      userEntity,
      entity('message', assistantID, {
        seq: 1,
        message: native(assistantID, 'assistant'),
        parts: { count: 1, through: 20 },
      }),
      entity('message-part', `${assistantID}/7`, {
        messageID: assistantID,
        ordinal: 7,
        position: 19,
        part: toolPart,
      }),
      userMapping,
      asset(
        'tool-image',
        'message-part',
        `${assistantID}/7`,
        '/part/state/content/1',
        `media:${mediaHash}`,
        mediaHash,
        3,
        'image/png'
      ),
      asset(
        'tool-pdf',
        'message-part',
        `${assistantID}/7`,
        '/part/state/content/2',
        '/synthetic/result.pdf',
        pdfHash,
        4,
        'application/pdf'
      ),
    ]);
    const readAsset = jest.fn(async (path: string, _advertisedBytes: number) => {
      if (path === `${sessionPath}/blobs/${mediaHash}`) return new Uint8Array([1, 2, 3]).buffer;
      if (path === `${sessionPath}/blobs/${pdfHash}`)
        return new Uint8Array([37, 80, 68, 70]).buffer;
      throw new Error(`Unexpected binary route ${path}`);
    });
    const snapshot = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
    expect(snapshot.messages[0]?.message).toEqual(storedUser);
    expect(snapshot.messages[0]?.message.files?.[0]).not.toHaveProperty('data');
    expect(snapshot.messages[1]?.message.content).toEqual([toolPart]);
    expect(snapshot.messages[1]?.partOrdinals).toEqual([7]);
    expect(readAsset.mock.calls.map(([path, bytes]) => [path, bytes])).toEqual([
      [`${sessionPath}/blobs/${mediaHash}`, 3],
      [`${sessionPath}/blobs/${pdfHash}`, 4],
    ]);
    const projection = projectNativeSnapshot(snapshot);
    expect(projection.messages[0]?.parts[1]).toMatchObject({
      id: kilo2PartId(storedUser.id, 1),
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,AQID',
    });
    const tool = projection.messages[1]?.parts[0];
    expect(tool).toMatchObject({
      type: 'tool',
      state: {
        status: 'completed',
        output: 'image and document',
      },
    });
    expect(projection.messages[1]?.parts.slice(1)).toMatchObject([
      {
        id: kilo2ToolFileId(assistantID, 0, 1),
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,AQID',
      },
      {
        id: kilo2ToolFileId(assistantID, 0, 2),
        type: 'file',
        mime: 'application/pdf',
        url: 'data:application/pdf;base64,JVBERg==',
      },
      {
        id: kilo2ToolFileId(assistantID, 0, 3),
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,BAU=',
      },
    ]);
  });

  it.each<[string, unknown[]]>([
    ['missing mapping', []],
    [
      'wrong pointer',
      [
        asset(
          'bad',
          'message',
          storedUser.id,
          '/message/files/1',
          `media:${mediaHash}`,
          mediaHash,
          3,
          'image/png'
        ),
      ],
    ],
    [
      'wrong owner',
      [
        asset(
          'bad',
          'message',
          'msg_other',
          '/message/files/0',
          `media:${mediaHash}`,
          mediaHash,
          3,
          'image/png'
        ),
      ],
    ],
    [
      'wrong reference',
      [
        asset(
          'bad',
          'message',
          storedUser.id,
          '/message/files/0',
          '/somewhere',
          mediaHash,
          3,
          'image/png'
        ),
      ],
    ],
    [
      'wrong MIME',
      [
        asset(
          'bad',
          'message',
          storedUser.id,
          '/message/files/0',
          `media:${mediaHash}`,
          mediaHash,
          3,
          'application/pdf'
        ),
      ],
    ],
    [
      'wrong content address',
      [
        asset(
          'bad',
          'message',
          storedUser.id,
          '/message/files/0',
          `media:${mediaHash}`,
          pdfHash,
          3,
          'image/png'
        ),
      ],
    ],
  ])('rejects %s before downloading private bytes', async (_name, mappings) => {
    const { request } = snapshotFetch([userEntity, ...mappings]);
    const readAsset = jest.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    await expect(
      fetchNativeSnapshot(request, sessionID, undefined, readAsset)
    ).rejects.toMatchObject({
      code: 'native_asset_not_found',
    });
    expect(readAsset).not.toHaveBeenCalled();
  });

  it('does not reinterpret tool input or metadata strings as downloadable files', async () => {
    const { request } = snapshotFetch([
      entity('message', 'msg_no_files', {
        seq: 0,
        message: native('msg_no_files', 'assistant', {
          content: [
            {
              type: 'tool',
              id: 'tool_input',
              name: 'read',
              state: {
                status: 'completed',
                input: { uri: `media:${mediaHash}` },
                metadata: { type: 'file', uri: `media:${mediaHash}`, mime: 'image/png' },
                content: [{ type: 'text', text: 'no attachments' }],
              },
            },
          ],
        }),
      }),
    ]);
    const readAsset = jest.fn(async () => new ArrayBuffer(0));
    const snapshot = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
    expect(snapshot.assetURLs).toBeUndefined();
    expect(readAsset).not.toHaveBeenCalled();
  });

  it('requires an authorized binary reader and checks the advertised byte length', async () => {
    const noReader = snapshotFetch([userEntity, userMapping]);
    await expect(fetchNativeSnapshot(noReader.request, sessionID)).rejects.toMatchObject({
      code: 'native_asset_reader_required',
    });
    const wrongSize = snapshotFetch([userEntity, userMapping]);
    await expect(
      fetchNativeSnapshot(
        wrongSize.request,
        sessionID,
        undefined,
        async () => new Uint8Array([1]).buffer
      )
    ).rejects.toMatchObject({ code: 'blob_hash_mismatch' });
  });

  it('cancels non-cooperative private asset reads under the snapshot deadline', async () => {
    const { request } = snapshotFetch([userEntity, userMapping]);
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let release: (bytes: ArrayBuffer) => void = () => {};
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const readAsset = jest.fn((_path: string, _advertisedBytes: number, init?: RequestInit) => {
      signal = init?.signal;
      markStarted();
      // Match the native ES2022/Hermes target, which lacks Promise.withResolvers.
      return new Promise<ArrayBuffer>(resolve => {
        release = resolve;
      });
    });
    const pending = fetchNativeSnapshot(request, sessionID, controller.signal, readAsset);
    await started;
    expect(readAsset).toHaveBeenCalledTimes(1);
    const rejected = expect(pending).rejects.toThrow('canceled');
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    release(new Uint8Array([1, 2, 3]).buffer);
    await Promise.resolve();
    expect(readAsset).toHaveBeenCalledTimes(1);
  });

  it('validates stored references and native tool files at the shared boundary', () => {
    expect(kilo2MessageSchema.parse(storedUser).files?.[0]).toEqual(storedUser.files[0]);
    expect(
      kilo2MessageSchema.safeParse({
        ...storedUser,
        files: [{ ...storedUser.files[0], uri: 'media:not-a-content-address' }],
      }).success
    ).toBe(false);
    expect(
      kilo2MessageSchema.safeParse(
        native('msg_invalid_file', 'assistant', {
          content: [
            {
              type: 'tool',
              state: {
                status: 'completed',
                input: {},
                content: [{ type: 'file', uri: 'data:image/png;base64,AQID' }],
              },
            },
          ],
        })
      ).success
    ).toBe(false);
  });
});

it('restarts the revision-pinned read when an authorized attachment blob was reclaimed', async () => {
  const mediaHash = 'e'.repeat(64);
  const message = native('msg_blob_race', 'user', {
    files: [{ mime: 'image/png', uri: `media:${mediaHash}`, source: { type: 'inline' } }],
  });
  const entities = [
    entity('message', message.id, { seq: 0, message }),
    entity('asset', 'race-asset', {
      entity: { kind: 'message', id: message.id },
      pointer: '/message/files/0',
      reference: `media:${mediaHash}`,
      mime: 'image/png',
      blob: { hash: mediaHash, bytes: 3 },
    }),
  ];
  const { request, fetch } = fakeFetch([
    { path: sessionPath, body: state() },
    { path: pagePath(), body: page(entities) },
    { path: sessionPath, body: state(5, 21) },
    { path: pagePath(5), body: page(entities, null, 5, 21) },
  ]);
  const readAsset = jest
    .fn(
      async (_path: string, _advertisedBytes: number, _init?: RequestInit) =>
        new Uint8Array([1, 2, 3]).buffer
    )
    .mockRejectedValueOnce(Object.assign(new Error('Reclaimed'), { code: 'blob_not_found' }));
  const snapshot = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
  expect(snapshot).toMatchObject({ revision: 5, position: 21 });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(readAsset).toHaveBeenCalledTimes(2);
});
