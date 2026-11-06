import { fetchNativeSnapshot } from './native-sync-snapshot';

const sessionID = 'ses_native';
const sessionPath = `/v1/sessions/${sessionID}`;
const hash = 'a'.repeat(64);

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
    message: { id: 'msg_assistant', type: 'assistant', native: { opaque: [null, true] } },
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
      message: { id: 'msg_user', type: 'user', text: 'hello', files: [] },
    });
    const session = entity('session', sessionID, { title: 'native' }, 1);
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
      { id: 'msg_user', role: 'user', content: 'hello', seq: 2 },
      {
        id: 'msg_assistant',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'first', native: { nil: null } },
          { type: 'text', text: 'last' },
        ],
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
        message: { id: 'msg_assistant', type: 'assistant', content },
      }),
      part(2),
    ]);

    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      { id: 'msg_assistant', role: 'assistant', content, seq: 0 },
    ]);
  });

  it('retains non-chat native messages and empty user text', async () => {
    const shell = { id: 'msg_shell', type: 'shell', command: 'pwd', status: 'completed' };
    const { request } = snapshotFetch([
      entity('message', 'msg_system', {
        seq: 1,
        message: { id: 'msg_system', type: 'system', text: 'instructions' },
      }),
      entity('message', 'msg_user', {
        seq: 0,
        message: { id: 'msg_user', type: 'user', text: '' },
      }),
      entity('message', 'msg_shell', { seq: 2, message: shell }),
    ]);

    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      { id: 'msg_user', role: 'user', content: '', seq: 0 },
      { id: 'msg_system', role: 'system', content: 'instructions', seq: 1 },
      { id: 'msg_shell', role: 'shell', content: shell, seq: 2 },
    ]);
  });

  it('accepts an explicitly empty envelope only when no parts exist', async () => {
    const { request } = snapshotFetch([envelope(0)]);
    expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
      { id: 'msg_assistant', role: 'assistant', content: [], seq: 7, partOrdinals: [] },
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
    ['malformed part', [envelope(1), entity('message-part', 'msg_assistant/2', null)]],
    [
      'invalid envelope count',
      [
        entity('message', 'msg_assistant', {
          seq: 7,
          message: { id: 'msg_assistant', type: 'assistant' },
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
          message: { id: 'msg_assistant', type: 'assistant', content: [] },
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
          message: { id: 'msg_assistant', type: 'assistant' },
        }),
      ],
    ],
  ])(
    'marks %s incomplete without displaying a truncated complete message',
    async (_name, entities) => {
      const { request } = snapshotFetch(entities);
      expect((await fetchNativeSnapshot(request, sessionID)).messages).toEqual([
        { id: 'msg_assistant', role: 'assistant', content: [], seq: 7, incomplete: true },
      ]);
    }
  );

  it('uses the snapshot source position, not transcript sequence or replication revision', async () => {
    const { request } = snapshotFetch([envelope(1, 100), part(2, 99)], 100);
    const result = await fetchNativeSnapshot(request, sessionID);
    expect(result).toMatchObject({ position: 100, revision: 4 });
    expect(result.messages[0]).toEqual({
      id: 'msg_assistant',
      role: 'assistant',
      content: [{ type: 'text', text: '2' }],
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
        id: 'msg_assistant',
        role: 'assistant',
        content: [{ type: 'text', text: '10' }],
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
      message: { id: 'msg_old', type: 'user', text: 'obsolete' },
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
          message: { id: 'msg_other', type: 'user', text: 'no' },
        }),
      ],
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
