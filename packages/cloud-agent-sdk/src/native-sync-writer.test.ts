import { createHash } from 'node:crypto';
import { NativeSyncClient, NativeSyncError } from './native-sync';
import {
  classifyConflict,
  encodeMessageChanges,
  encodeSessionEntity,
  NativeSyncWriter,
  nextSeq,
  packetAdmissionViolation,
  sha256Hex,
  type NativeSyncChange,
  type NativeSyncPacket,
  type PortableMessage,
} from './native-sync-writer';
import { fetchNativeSnapshot, nativeSnapshotSessionSchema } from './native-sync-snapshot';
import { kilo2MessageSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

function changeValue(change: NativeSyncChange): unknown {
  if (change.op === 'put' && 'value' in change) return change.value;
  throw new Error(`Expected an inline put change for ${change.kind}/${change.id}`);
}

const sessionID = 'ses_writer';
const sessionPath = `/v1/sessions/${sessionID}`;
const sourceID = '00000000-0000-4000-8000-000000000002';
const batchID = '00000000-0000-4000-8000-000000000003';
const digest = 'b'.repeat(64);

const receipt = {
  version: 1,
  sessionID,
  batchID,
  after: 0,
  through: 3,
  revision: 2,
  changes: 4,
  digest,
  committedAt: 2,
};

function liveState(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionID,
    tenant: { type: 'user', id: 'user_1' },
    deleted: false,
    creatorID: 'user_1',
    sourceID,
    sources: [{ sourceID, client: 'mobile', joinedAt: 1 }],
    position: 3,
    revision: 2,
    batches: 1,
    lastReceipt: receipt,
    usage: { entities: 4, inlineBytes: 10, blobBytes: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

type Call = { path: string; method: string; body: unknown; headers: Record<string, string> };
type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

function errorResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return Response.json(
    { error: { code, message: code, ...extra } },
    { status, headers: { 'content-type': 'application/json', ...headers } }
  );
}

function makeClient(handler: Handler) {
  const calls: Call[] = [];
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    if (url.pathname === '/v1/auth/exchange') {
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    const response = await handler(call);
    if (response) return response;
    throw new Error(`Unexpected fetch ${call.method} ${call.path}`);
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'credential',
    fetch: fetcher as unknown as typeof fetch,
  });
  return { client, calls, fetcher };
}

function packet(changes: NativeSyncChange[]): NativeSyncPacket {
  return { batchID, sourceID, after: 0, through: 3, changes };
}

const userMessage: PortableMessage = {
  type: 'user',
  id: 'msg_user',
  seq: 1,
  text: 'hello',
  files: [],
  time: { created: 10 },
};

describe('sha256Hex', () => {
  it('matches node crypto for strings and bytes', () => {
    for (const value of ['', 'abc', 'message:msg_user:/message/files/0', 'x'.repeat(1000)]) {
      expect(sha256Hex(value)).toBe(createHash('sha256').update(value).digest('hex'));
    }
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('encoders', () => {
  it('encodes the mobile session entity without agent or directory', () => {
    expect(
      encodeSessionEntity({
        id: sessionID,
        title: 'Chat',
        model: { providerID: 'kilo', id: 'model-1' },
        time: { created: 1, updated: 2, idle: 3 },
      })
    ).toStrictEqual({
      op: 'put',
      kind: 'session',
      id: sessionID,
      value: {
        id: sessionID,
        title: 'Chat',
        model: { id: 'model-1', providerID: 'kilo' },
        time: { created: 1, updated: 2, idle: 3 },
        origin: { directory: '', client: 'mobile' },
      },
    });
  });

  it('encodes a user message with a file asset mapping', () => {
    const hash = 'a'.repeat(64);
    const changes = encodeMessageChanges(
      [
        {
          type: 'user',
          id: 'msg_user',
          seq: 1,
          text: 'look',
          files: [{ mime: 'image/png', name: 'shot.png', blob: { hash, bytes: 5 } }],
          time: { created: 10 },
        },
      ],
      3
    );
    expect(changes).toStrictEqual([
      {
        op: 'put',
        kind: 'message',
        id: 'msg_user',
        value: {
          seq: 1,
          message: {
            id: 'msg_user',
            type: 'user',
            text: 'look',
            files: [
              {
                mime: 'image/png',
                name: 'shot.png',
                uri: `media:${hash}`,
                source: { type: 'inline' },
              },
            ],
            time: { created: 10 },
          },
        },
      },
      {
        op: 'put',
        kind: 'asset',
        id: createHash('sha256').update('message:msg_user:/message/files/0').digest('hex'),
        value: {
          entity: { kind: 'message', id: 'msg_user' },
          pointer: '/message/files/0',
          reference: `media:${hash}`,
          blob: { hash, bytes: 5 },
          mime: 'image/png',
          name: 'shot.png',
        },
      },
    ]);
  });

  it('encodes a split assistant with part entities and no inline content', () => {
    const changes = encodeMessageChanges(
      [
        {
          type: 'assistant',
          id: 'msg_assistant',
          seq: 2,
          agent: 'code',
          model: { providerID: 'kilo', id: 'model-1', variant: 'high' },
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'done' },
            {
              type: 'tool',
              id: 'call_1',
              name: 'read',
              state: {
                status: 'completed',
                input: { path: 'a.ts' },
                content: [{ type: 'text', text: 'contents' }],
              },
            },
          ],
          finish: 'stop',
          time: { created: 11, completed: 12 },
        },
      ],
      3
    );
    expect(changes[0]).toStrictEqual({
      op: 'put',
      kind: 'message',
      id: 'msg_assistant',
      value: {
        seq: 2,
        message: {
          id: 'msg_assistant',
          type: 'assistant',
          agent: 'code',
          model: { id: 'model-1', providerID: 'kilo', variant: 'high' },
          finish: 'stop',
          time: { created: 11, completed: 12 },
        },
        parts: { count: 3, through: 3 },
      },
    });
    expect(changes.slice(1)).toStrictEqual([
      {
        op: 'put',
        kind: 'message-part',
        id: 'msg_assistant/0',
        value: {
          messageID: 'msg_assistant',
          ordinal: 0,
          position: 3,
          part: { type: 'reasoning', text: 'thinking' },
        },
      },
      {
        op: 'put',
        kind: 'message-part',
        id: 'msg_assistant/1',
        value: {
          messageID: 'msg_assistant',
          ordinal: 1,
          position: 3,
          part: { type: 'text', text: 'done' },
        },
      },
      {
        op: 'put',
        kind: 'message-part',
        id: 'msg_assistant/2',
        value: {
          messageID: 'msg_assistant',
          ordinal: 2,
          position: 3,
          part: {
            type: 'tool',
            id: 'call_1',
            name: 'read',
            state: {
              status: 'completed',
              input: { path: 'a.ts' },
              content: [{ type: 'text', text: 'contents' }],
            },
          },
        },
      },
    ]);
  });

  it('encodes an idle envelope', () => {
    expect(
      encodeMessageChanges(
        [{ type: 'idle', id: 'msg_idle', seq: 3, outcome: 'interrupted', time: { created: 13 } }],
        3
      )
    ).toStrictEqual([
      {
        op: 'put',
        kind: 'message',
        id: 'msg_idle',
        value: {
          seq: 3,
          message: { id: 'msg_idle', type: 'idle', outcome: 'interrupted', time: { created: 13 } },
        },
      },
    ]);
  });
});

describe('encode to snapshot-reader round-trip', () => {
  it('reconstructs user file, split assistant, and idle through fetchNativeSnapshot', async () => {
    const blobBytes = new TextEncoder().encode('hello');
    const hash = sha256Hex(blobBytes);
    const position = 3;
    const changes: NativeSyncChange[] = [
      encodeSessionEntity({ id: sessionID, title: 'Chat', time: { created: 1, updated: 2 } }),
      ...encodeMessageChanges(
        [
          {
            type: 'user',
            id: 'msg_user',
            seq: 1,
            text: 'look',
            files: [{ mime: 'text/plain', blob: { hash, bytes: blobBytes.byteLength } }],
            time: { created: 10 },
          },
          {
            type: 'assistant',
            id: 'msg_assistant',
            seq: 2,
            agent: 'code',
            model: { providerID: 'kilo', id: 'model-1' },
            content: [
              { type: 'text', text: 'answer' },
              { type: 'reasoning', text: 'because' },
              {
                type: 'tool',
                id: 'call_1',
                name: 'read',
                state: {
                  status: 'error',
                  input: { path: 'a.ts' },
                  content: [{ type: 'text', text: 'missing' }],
                },
              },
            ],
            finish: 'stop',
            time: { created: 11, completed: 12 },
          },
          { type: 'idle', id: 'msg_idle', seq: 3, outcome: 'succeeded', time: { created: 13 } },
        ],
        position
      ),
    ];
    expect(packetAdmissionViolation(changes)).toBeNull();
    const entities = changes
      .filter(change => change.op === 'put' && 'value' in change)
      .map(change => ({
        kind: change.kind,
        id: change.id,
        revision: 1,
        value: changeValue(change),
      }));
    const request = async <T>(path: string): Promise<T> => {
      if (path === sessionPath) return liveState({ revision: 1 }) as T;
      if (path.startsWith(`${sessionPath}/entities?`)) {
        return { version: 1, sessionID, revision: 1, position, entities, next: null } as T;
      }
      throw new Error(`Unexpected request ${path}`);
    };
    const readAsset = async (path: string, advertisedBytes: number) => {
      expect(path).toBe(`${sessionPath}/blobs/${hash}`);
      expect(advertisedBytes).toBe(blobBytes.byteLength);
      return blobBytes.buffer.slice(
        blobBytes.byteOffset,
        blobBytes.byteOffset + blobBytes.byteLength
      ) as ArrayBuffer;
    };
    const snapshot = await fetchNativeSnapshot(request, sessionID, undefined, readAsset);
    expect(snapshot.session).toMatchObject({ id: sessionID, title: 'Chat' });
    expect(snapshot.messages.map(message => message.message.id)).toStrictEqual([
      'msg_user',
      'msg_assistant',
      'msg_idle',
    ]);
    expect(snapshot.messages.every(message => message.incomplete !== true)).toBe(true);
    expect(snapshot.messages[0]?.message).toMatchObject({
      type: 'user',
      text: 'look',
      files: [{ mime: 'text/plain', uri: `media:${hash}` }],
    });
    expect(Object.values(snapshot.assetURLs ?? {})).toStrictEqual([
      `data:text/plain;base64,${Buffer.from(blobBytes).toString('base64')}`,
    ]);
    expect(snapshot.messages[1]?.message).toMatchObject({
      type: 'assistant',
      agent: 'code',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'because' },
        {
          type: 'tool',
          id: 'call_1',
          state: { status: 'error', content: [{ type: 'text', text: 'missing' }] },
        },
      ],
    });
    expect(snapshot.messages[1]?.partOrdinals).toStrictEqual([0, 1, 2]);
    expect(snapshot.messages[2]?.message).toMatchObject({ type: 'idle', outcome: 'succeeded' });
  });
});

describe('packet admission', () => {
  it('accepts a small packet', () => {
    expect(packetAdmissionViolation(encodeMessageChanges([userMessage], 1))).toBeNull();
  });

  it('rejects more than 64 changes', () => {
    const changes: NativeSyncChange[] = Array.from({ length: 65 }, (_, index) => ({
      op: 'put',
      kind: 'message',
      id: `msg_${index}`,
      value: { seq: index },
    }));
    expect(packetAdmissionViolation(changes)).toBe('too_many_changes');
  });

  it('rejects one inline value over 64 KiB', () => {
    const changes = encodeMessageChanges([{ ...userMessage, text: 'x'.repeat(65_537) }], 1);
    expect(packetAdmissionViolation(changes)).toBe('inline_too_large');
  });

  it('rejects inline values totaling over 512 KiB', () => {
    const messages: PortableMessage[] = Array.from({ length: 9 }, (_, index) => ({
      type: 'user',
      id: `msg_${index}`,
      seq: index + 1,
      text: 'x'.repeat(60_000),
      files: [],
      time: { created: 1 },
    }));
    expect(packetAdmissionViolation(encodeMessageChanges(messages, 9))).toBe('packet_too_large');
  });
});

describe('sequence helpers', () => {
  it('nextSeq sits above both pulled and local maxima', () => {
    expect(nextSeq(0, 0)).toBe(1);
    expect(nextSeq(7, 3)).toBe(8);
    expect(nextSeq(3, 7)).toBe(8);
  });

  it('classifyConflict fast-forwards only when every unacked seq is above the pulled max', () => {
    expect(classifyConflict([], 5)).toBe('fast-forward');
    expect(classifyConflict([{ seq: 6 }, { seq: 7 }], 5)).toBe('fast-forward');
    expect(classifyConflict([{ seq: 5 }], 5)).toBe('diverged');
    expect(classifyConflict([{ seq: 6 }, { seq: 4 }], 5)).toBe('diverged');
  });
});

describe('NativeSyncWriter.register', () => {
  it('returns the live state on success and sends the client kind', async () => {
    const { client, calls } = makeClient(call =>
      call.path === sessionPath && call.method === 'PUT' ? Response.json(liveState()) : undefined
    );
    const writer = new NativeSyncWriter(client);
    await expect(writer.register(sessionID, sourceID, 'mobile')).resolves.toStrictEqual({
      type: 'registered',
      state: liveState(),
    });
    const put = calls.find(call => call.method === 'PUT');
    expect(JSON.parse(String(put?.body))).toStrictEqual({
      version: 1,
      sourceID,
      client: 'mobile',
    });
  });

  it('maps a tombstone to deleted', async () => {
    const { client } = makeClient(() => errorResponse(410, 'session_deleted'));
    await expect(
      new NativeSyncWriter(client).register(sessionID, sourceID, 'mobile')
    ).resolves.toStrictEqual({
      type: 'deleted',
    });
  });

  it('maps overload to retryable with the retry delay', async () => {
    const { client } = makeClient(() =>
      errorResponse(503, 'service_overloaded', {}, { 'Retry-After': '3' })
    );
    await expect(
      new NativeSyncWriter(client).register(sessionID, sourceID, 'mobile')
    ).resolves.toStrictEqual({
      type: 'retryable',
      retryAfterMs: 3000,
    });
  });

  it('maps a creator mismatch to failed', async () => {
    const { client } = makeClient(() => errorResponse(403, 'creator_mismatch'));
    await expect(
      new NativeSyncWriter(client).register(sessionID, sourceID, 'mobile')
    ).resolves.toStrictEqual({
      type: 'failed',
      code: 'creator_mismatch',
    });
  });
});

describe('NativeSyncWriter.putBlob', () => {
  it('uploads under the content hash and returns the reference', async () => {
    const bytes = new TextEncoder().encode('hello');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const { client, calls } = makeClient(call =>
      call.path === `${sessionPath}/blobs/${hash}`
        ? Response.json(
            { version: 1, hash, bytes: bytes.byteLength, created: true },
            { status: 201 }
          )
        : undefined
    );
    const writer = new NativeSyncWriter(client);
    await expect(writer.putBlob(sessionID, bytes, 'text/plain')).resolves.toStrictEqual({
      hash,
      bytes: 5,
    });
    const put = calls.find(call => call.path.includes('/blobs/'));
    expect(put?.method).toBe('PUT');
    expect(put?.body).toBe(bytes);
    expect(put?.headers['Content-Type']).toBe('text/plain');
    expect(put?.headers['Content-Length']).toBe('5');
  });

  it('accepts an already-stored blob (200)', async () => {
    const bytes = new TextEncoder().encode('hello');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const { client } = makeClient(() =>
      Response.json({ version: 1, hash, bytes: 5, created: false })
    );
    await expect(
      new NativeSyncWriter(client).putBlob(sessionID, bytes, 'text/plain')
    ).resolves.toStrictEqual({
      hash,
      bytes: 5,
    });
  });

  it('throws when the acknowledgement disagrees with the uploaded bytes', async () => {
    const bytes = new TextEncoder().encode('hello');
    const { client } = makeClient(() =>
      Response.json({ version: 1, hash: 'f'.repeat(64), bytes: 5, created: true })
    );
    await expect(
      new NativeSyncWriter(client).putBlob(sessionID, bytes, 'text/plain')
    ).rejects.toBeInstanceOf(NativeSyncError);
  });
});

describe('NativeSyncWriter.commit', () => {
  const changes = encodeMessageChanges([userMessage], 3);

  it('returns the receipt and posts the frozen packet', async () => {
    const { client, calls } = makeClient(call =>
      call.path === `${sessionPath}/batches` ? Response.json(receipt, { status: 201 }) : undefined
    );
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'committed',
      receipt,
    });
    const post = calls.find(call => call.path === `${sessionPath}/batches`);
    expect(JSON.parse(String(post?.body))).toStrictEqual({
      version: 1,
      sourceID,
      batchID,
      after: 0,
      through: 3,
      changes,
    });
  });

  it('maps batch_superseded with the committed position', async () => {
    const { client } = makeClient(() =>
      errorResponse(409, 'batch_superseded', { position: 9, details: { position: 9 } })
    );
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'superseded',
      position: 9,
    });
  });

  it('maps position_conflict with the committed position from details', async () => {
    const { client } = makeClient(() =>
      errorResponse(409, 'position_conflict', { details: { position: 4 } })
    );
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'conflict',
      position: 4,
    });
  });

  it('maps a tombstone to deleted', async () => {
    const { client } = makeClient(() => errorResponse(410, 'session_deleted'));
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'deleted',
    });
  });

  it('maps rate limiting to retryable', async () => {
    const { client } = makeClient(() =>
      errorResponse(429, 'rate_limited', {}, { 'Retry-After': '2' })
    );
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'retryable',
      retryAfterMs: 2000,
    });
  });

  it('maps an unregistered source to failed', async () => {
    const { client } = makeClient(() => errorResponse(409, 'source_conflict'));
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(changes))
    ).resolves.toStrictEqual({
      type: 'failed',
      code: 'source_conflict',
    });
  });

  it('refuses an oversized packet without a network call', async () => {
    const { client, calls } = makeClient(() => Response.json(receipt));
    const oversized: NativeSyncChange[] = Array.from({ length: 65 }, (_, index) => ({
      op: 'put',
      kind: 'message',
      id: `msg_${index}`,
      value: { seq: index },
    }));
    await expect(
      new NativeSyncWriter(client).commit(sessionID, packet(oversized))
    ).resolves.toStrictEqual({
      type: 'failed',
      code: 'too_many_changes',
    });
    expect(calls).toStrictEqual([]);
  });
});

describe('NativeSyncWriter.pull', () => {
  function pulledHandler(call: Call) {
    if (call.path === sessionPath) return Response.json(liveState());
    if (call.path.startsWith(`${sessionPath}/entities?`)) {
      const changes: NativeSyncChange[] = [
        encodeSessionEntity({
          id: sessionID,
          title: 'Chat',
          time: { created: 1, updated: 2 },
        }),
        ...encodeMessageChanges(
          [
            { ...userMessage, seq: 2 },
            { type: 'idle', id: 'msg_idle', seq: 5, outcome: 'succeeded', time: { created: 13 } },
          ],
          3
        ),
      ];
      return Response.json({
        version: 1,
        sessionID,
        revision: 2,
        position: 3,
        entities: changes.map(change => ({
          kind: change.kind,
          id: change.id,
          revision: 2,
          value: changeValue(change),
          sourceID: change.kind === 'message' && change.id === 'msg_user' ? sourceID : null,
        })),
        next: null,
      });
    }
    return undefined;
  }

  it('pulls state, session, ordered side-tagged messages and maxSeq', async () => {
    const { client } = makeClient(pulledHandler);
    const result = await new NativeSyncWriter(client).pull(sessionID);
    expect(result.type).toBe('pulled');
    if (result.type !== 'pulled') return;
    expect(result.snapshot.position).toBe(3);
    expect(result.snapshot.revision).toBe(2);
    expect(result.snapshot.lastReceipt).toStrictEqual(receipt);
    expect(result.snapshot.sources).toStrictEqual([{ sourceID, client: 'mobile', joinedAt: 1 }]);
    expect(result.snapshot.session).toMatchObject({ id: sessionID, title: 'Chat' });
    expect(
      result.snapshot.messages.map(message => ({
        id: message.message.id,
        seq: message.seq,
        sourceID: message.sourceID,
      }))
    ).toStrictEqual([
      { id: 'msg_user', seq: 2, sourceID },
      { id: 'msg_idle', seq: 5, sourceID: null },
    ]);
    expect(result.snapshot.maxSeq).toBe(5);
  });

  it('maps a deleted state to deleted', async () => {
    const { client } = makeClient(call =>
      call.path === sessionPath
        ? Response.json({
            version: 1,
            sessionID,
            tenant: { type: 'user', id: 'user_1' },
            deleted: true,
            deletedAt: 5,
          })
        : undefined
    );
    await expect(new NativeSyncWriter(client).pull(sessionID)).resolves.toStrictEqual({
      type: 'deleted',
    });
  });

  it('maps an unknown session to not_found', async () => {
    const { client } = makeClient(() => errorResponse(404, 'session_not_found'));
    await expect(new NativeSyncWriter(client).pull(sessionID)).resolves.toStrictEqual({
      type: 'not_found',
    });
  });

  it('maps overload to retryable', async () => {
    const { client } = makeClient(() => errorResponse(503, 'tenant_unavailable'));
    await expect(new NativeSyncWriter(client).pull(sessionID)).resolves.toStrictEqual({
      type: 'retryable',
    });
  });

  it('maps a creator mismatch to failed', async () => {
    const { client } = makeClient(() => errorResponse(403, 'creator_mismatch'));
    await expect(new NativeSyncWriter(client).pull(sessionID)).resolves.toStrictEqual({
      type: 'failed',
      code: 'creator_mismatch',
    });
  });
});

describe('NativeSyncClient.listSessions', () => {
  const item = {
    sessionID,
    tenant: { type: 'user', id: 'user_1' },
    createdAt: 1,
    updatedAt: 9,
    title: 'Chat',
    client: 'mobile',
    directory: null,
    archived: false,
    live: true,
  };

  it('parses the filtered item shape and encodes every filter', async () => {
    const { client, calls } = makeClient(() => Response.json({ items: [item], cursor: 'next' }));
    await expect(
      client.listSessions({
        cursor: 'cur',
        limit: 10,
        q: 'cha',
        client: 'mobile',
        directory: '/repo',
        archived: true,
      })
    ).resolves.toStrictEqual({ items: [item], cursor: 'next' });
    const list = calls.find(call => call.path.startsWith('/v1/sessions?'));
    const params = new URLSearchParams(list?.path.split('?')[1]);
    expect([...params.entries()].sort()).toStrictEqual(
      [
        ['archived', 'true'],
        ['client', 'mobile'],
        ['cursor', 'cur'],
        ['directory', '/repo'],
        ['limit', '10'],
        ['q', 'cha'],
      ].sort()
    );
  });

  it('keeps the legacy cursor call working with the default limit', async () => {
    const { client, calls } = makeClient(() => Response.json({ items: [], cursor: null }));
    await expect(client.listSessions('cur')).resolves.toStrictEqual({ items: [], cursor: null });
    const list = calls.find(call => call.path.startsWith('/v1/sessions?'));
    expect(list?.path).toBe('/v1/sessions?limit=50&cursor=cur');
  });

  it('fills defaults when the service omits the list metadata', async () => {
    const legacy = {
      sessionID,
      tenant: { type: 'user', id: 'user_1' },
      createdAt: 4,
      live: false,
    };
    const { client } = makeClient(() => Response.json({ items: [legacy], cursor: null }));
    await expect(client.listSessions()).resolves.toStrictEqual({
      items: [
        {
          ...legacy,
          updatedAt: 4,
          title: null,
          client: 'cli',
          directory: null,
          archived: false,
        },
      ],
      cursor: null,
    });
  });
});

describe('NativeSyncClient.deleteSession', () => {
  it('returns deleted on success', async () => {
    const { client, calls } = makeClient(() =>
      Response.json({ version: 1, sessionID, deleted: true, deletedAt: 5 })
    );
    await expect(client.deleteSession(sessionID)).resolves.toStrictEqual({ type: 'deleted' });
    expect(calls.some(call => call.method === 'DELETE' && call.path === sessionPath)).toBe(true);
  });

  it('treats an existing tombstone as deleted', async () => {
    const { client } = makeClient(() => errorResponse(410, 'session_deleted'));
    await expect(client.deleteSession(sessionID)).resolves.toStrictEqual({ type: 'deleted' });
  });

  it('maps an unknown session to not_found', async () => {
    const { client } = makeClient(() => errorResponse(404, 'session_not_found'));
    await expect(client.deleteSession(sessionID)).resolves.toStrictEqual({ type: 'not_found' });
  });

  it('maps rate limiting to retryable', async () => {
    const { client } = makeClient(() =>
      errorResponse(429, 'rate_limited', {}, { 'Retry-After': '1' })
    );
    await expect(client.deleteSession(sessionID)).resolves.toStrictEqual({
      type: 'retryable',
      retryAfterMs: 1000,
    });
  });

  it('maps a creator mismatch to failed', async () => {
    const { client } = makeClient(() => errorResponse(403, 'creator_mismatch'));
    await expect(client.deleteSession(sessionID)).resolves.toStrictEqual({
      type: 'failed',
      code: 'creator_mismatch',
    });
  });
});

// Golden shapes copied from the CLI producer's own fixtures
// (kilocode v2 packages/kilo-cli/test/session-sync-parts.test.ts and
// session-sync-assets.test.ts). The CLI's sparse native ordinals and capture
// positions are artifacts of its part rows; a new writer assigns dense
// ordinals and stamps parts at the committing packet's `through`.
describe('CLI golden fixtures', () => {
  it('split assistant envelope and parts match the CLI reader fixture field-for-field', () => {
    const changes = encodeMessageChanges(
      [
        {
          type: 'assistant',
          id: 'msg_sync_parts',
          seq: 7,
          agent: 'build',
          model: { providerID: 'fixture', id: 'model', variant: 'default' },
          content: [
            { type: 'reasoning', text: 'first' },
            { type: 'text', text: 'last' },
          ],
          time: { created: 10, completed: 20 },
        },
      ],
      20
    );
    expect(changes).toStrictEqual([
      {
        op: 'put',
        kind: 'message',
        id: 'msg_sync_parts',
        value: {
          seq: 7,
          message: {
            id: 'msg_sync_parts',
            type: 'assistant',
            agent: 'build',
            model: { id: 'model', providerID: 'fixture', variant: 'default' },
            time: { created: 10, completed: 20 },
          },
          parts: { count: 2, through: 20 },
        },
      },
      {
        op: 'put',
        kind: 'message-part',
        id: 'msg_sync_parts/0',
        value: {
          messageID: 'msg_sync_parts',
          ordinal: 0,
          position: 20,
          part: { type: 'reasoning', text: 'first' },
        },
      },
      {
        op: 'put',
        kind: 'message-part',
        id: 'msg_sync_parts/1',
        value: {
          messageID: 'msg_sync_parts',
          ordinal: 1,
          position: 20,
          part: { type: 'text', text: 'last' },
        },
      },
    ]);
  });

  it('user media file and asset mapping match the CLI asset fixture', () => {
    const bytes = Buffer.from('native database-backed media');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const changes = encodeMessageChanges(
      [
        {
          type: 'user',
          id: 'msg_asset_user',
          seq: 0,
          text: 'user',
          files: [
            {
              mime: 'application/octet-stream',
              name: 'native.bin',
              blob: { hash, bytes: bytes.byteLength },
            },
          ],
          time: { created: 1 },
        },
      ],
      1
    );
    const [messageChange] = changes;
    if (!messageChange) throw new Error('Expected a message change');
    expect(changeValue(messageChange)).toStrictEqual({
      seq: 0,
      message: {
        id: 'msg_asset_user',
        type: 'user',
        text: 'user',
        files: [
          {
            mime: 'application/octet-stream',
            name: 'native.bin',
            uri: `media:${hash}`,
            source: { type: 'inline' },
          },
        ],
        time: { created: 1 },
      },
    });
    expect(changes[1]).toStrictEqual({
      op: 'put',
      kind: 'asset',
      id: createHash('sha256').update('message:msg_asset_user:/message/files/0').digest('hex'),
      value: {
        entity: { kind: 'message', id: 'msg_asset_user' },
        pointer: '/message/files/0',
        reference: `media:${hash}`,
        blob: { hash, bytes: bytes.byteLength },
        mime: 'application/octet-stream',
        name: 'native.bin',
      },
    });
  });

  it('encoded session and messages pass the session-ingest contract schemas', () => {
    const session = encodeSessionEntity({
      id: sessionID,
      title: 'Chat',
      model: { providerID: 'kilo', id: 'model-1' },
      time: { created: 1, updated: 2 },
    });
    const sessionValue = changeValue(session);
    expect(sessionValue).not.toHaveProperty('location');
    expect(() => nativeSnapshotSessionSchema.parse(sessionValue)).not.toThrow();
    const changes = encodeMessageChanges(
      [
        userMessage,
        {
          type: 'assistant',
          id: 'msg_assistant',
          seq: 2,
          agent: 'build',
          model: { providerID: 'fixture', id: 'model', variant: 'default' },
          content: [
            {
              type: 'tool',
              id: 'call_original',
              name: 'read',
              state: {
                status: 'completed',
                input: { path: 'a.ts' },
                content: [{ type: 'text', text: 'third' }],
              },
            },
          ],
          time: { created: 10, completed: 20 },
        },
        { type: 'idle', id: 'msg_idle', seq: 3, outcome: 'succeeded', time: { created: 20 } },
      ],
      3
    );
    for (const change of changes) {
      if (change.kind !== 'message') continue;
      expect(() =>
        z.object({ message: kilo2MessageSchema }).parse(changeValue(change))
      ).not.toThrow();
    }
  });
});
