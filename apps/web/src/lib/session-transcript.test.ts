import { decodeJwt } from 'jose';
import { v2SnapshotToLogEntries } from './code-reviews/session-log';
import { fetchSessionSnapshot } from './session-ingest-client';
import { fetchSessionTranscript } from './session-transcript';

jest.mock('./session-ingest-client', () => ({ fetchSessionSnapshot: jest.fn() }));
jest.mock('./web-config.server', () => ({ SESSION_SYNC_WORKER_URL: 'https://sync.test' }));

const session = {
  sessionId: 'ses_transcript',
  userId: 'oauth/test:transcript-owner',
  organizationId: '00000000-0000-4000-8000-000000000001',
  version: 2,
};
const path = `/v1/sessions/${session.sessionId}`;
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const revision = 1;
const position = 4;
const entity = (kind: string, id: string, value: unknown) => ({ kind, id, revision, value });

function mockSnapshot(entities: ReturnType<typeof entity>[]) {
  const state = { version: 1, sessionID: session.sessionId, revision, position };
  fetchMock
    .mockResolvedValueOnce(Response.json({ ...state, deleted: false }))
    .mockResolvedValueOnce(
      Response.json({
        ...state,
        next: null,
        entities: [
          entity('session', session.sessionId, {
            id: session.sessionId,
            origin: { directory: '/workspace' },
            title: 'Transcript',
            time: { created: 1, updated: 2 },
          }),
          ...entities,
        ],
      })
    );
}

function readCredential(call: number) {
  const authorization = new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get('Authorization');
  expect(authorization).toMatch(/^SessionTranscript /);
  return decodeJwt(authorization?.split(' ')[1] ?? '');
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
});

afterEach(() => jest.restoreAllMocks());

it('reconstructs ordered sync-only messages and reports incomplete messages', async () => {
  const part = (ordinal: number, text: string) =>
    entity('message-part', `msg_assistant/${ordinal}`, {
      messageID: 'msg_assistant',
      ordinal,
      position: 3,
      part: { type: 'text', text },
    });
  mockSnapshot([
    entity('message', 'msg_assistant', {
      seq: 1,
      message: { id: 'msg_assistant', type: 'assistant', time: { created: 2 } },
      parts: { count: 2, through: position },
    }),
    part(10, 'second'),
    part(2, 'first'),
    entity('message', 'msg_incomplete', {
      seq: 2,
      message: { id: 'msg_incomplete', type: 'assistant', time: { created: 3 } },
    }),
  ]);

  const transcript = await fetchSessionTranscript(session);
  expect(transcript).toMatchObject({
    source: 'sync',
    incompleteMessageCount: 1,
    messages: [
      {
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ],
  });
  expect(v2SnapshotToLogEntries(transcript ?? { messages: [] }).at(-1)).toMatchObject({
    eventType: 'status',
    message: 'Transcript incomplete: 1 message could not be loaded.',
  });
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    `https://sync.test${path}`,
    `https://sync.test${path}/entities?revision=1&limit=100`,
  ]);
  expect(readCredential(0)).toMatchObject({
    sub: session.userId,
    aud: 'session-sync:transcript',
    sessionID: session.sessionId,
    organizationID: session.organizationId,
  });
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it.each([
  ['staging', 'production', 'staging'],
  ['production', 'production', 'production'],
  [undefined, 'development', 'development'],
] as const)(
  'sets the Worker environment claim for target %s and NODE_ENV %s',
  async (target, node, env) => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      VERCEL_TARGET_ENV: target,
      NODE_ENV: node,
    });
    mockSnapshot([]);

    await fetchSessionTranscript(session);

    expect(readCredential(0).env).toBe(env);
  }
);

const attachmentHash = 'a'.repeat(64);
const attachmentURI = `media:${attachmentHash}`;

function mockAttachment() {
  mockSnapshot([
    entity('message', 'msg_user', {
      seq: 1,
      message: {
        id: 'msg_user',
        type: 'user',
        time: { created: 2 },
        files: [{ mime: 'image/png', uri: attachmentURI, source: { type: 'inline' } }],
      },
    }),
    entity('asset', 'asset_image', {
      entity: { kind: 'message', id: 'msg_user' },
      pointer: '/message/files/0',
      reference: attachmentURI,
      mime: 'image/png',
      blob: { hash: attachmentHash, bytes: 3 },
    }),
  ]);
}

it('reads an attachment and gives later requests a fresh one-minute credential', async () => {
  const originalTime = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(originalTime);
  mockAttachment();
  fetchMock.mockResolvedValueOnce(new Response('png'));
  jest.spyOn(global, 'fetch').mockImplementation(async (...args) => {
    const response = await fetchMock(...args);
    if (String(args[0]).includes('/entities?')) {
      now.mockReturnValue(originalTime + 61_000);
    }
    return response;
  });

  await expect(fetchSessionTranscript(session)).resolves.toMatchObject({
    messages: [{ parts: [{ type: 'text' }, { type: 'file', url: 'data:image/png;base64,cG5n' }] }],
  });
  expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
    `https://sync.test${path}/blobs/${attachmentHash}`
  );
  const iat = Math.floor((originalTime + 61_000) / 1000);
  expect(readCredential(2)).toMatchObject({ iat, exp: iat + 60 });
});

it.each([
  ['under', () => new Response('pn'), { code: 'blob_hash_mismatch' }],
  [
    'over',
    () => new Response('png!'),
    { message: 'Session sync attachment exceeds its advertised size' },
  ],
  [
    'failed',
    () => Response.json({ error: { code: 'blob_forbidden' } }, { status: 403 }),
    { code: 'blob_forbidden' },
  ],
])('rejects %s attachment responses', async (_label, response, error) => {
  mockAttachment();
  fetchMock.mockResolvedValueOnce(response());

  await expect(fetchSessionTranscript(session)).rejects.toMatchObject(error);
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it.each([0, 1])('uses ingest for session version %i without contacting sync', async version => {
  jest.mocked(fetchSessionSnapshot).mockResolvedValue({ info: {}, messages: [] });
  await expect(fetchSessionTranscript({ ...session, version })).resolves.toEqual({
    source: 'ingest',
    messages: [],
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('uses ingest for older Kilo v2 sessions that were never registered with sync', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: 'session_not_found' } }, { status: 404 })
  );
  jest.mocked(fetchSessionSnapshot).mockResolvedValue({ info: {}, messages: [] });
  await expect(fetchSessionTranscript(session)).resolves.toEqual({
    source: 'ingest',
    messages: [],
  });
  expect(fetchSessionSnapshot).toHaveBeenCalledWith(session.sessionId, session.userId);
});

it('does not use ingest if the synced session was deleted', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: 'session_deleted' } }, { status: 410 })
  );
  await expect(fetchSessionTranscript(session)).resolves.toBeNull();
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it.each([
  [403, 'forbidden'],
  [503, 'auth_unavailable'],
])('preserves sync errors (%i) without falling back to ingest', async (status, code) => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
  await expect(fetchSessionTranscript(session)).rejects.toMatchObject({ code });
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});
