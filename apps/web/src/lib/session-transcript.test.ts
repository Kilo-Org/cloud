import { decodeJwt } from 'jose';
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
const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
});

afterEach(() => jest.restoreAllMocks());

it('reconstructs sync-only messages and preserves native part ordering', async () => {
  const revision = 1;
  const position = 4;
  const entity = (kind: string, id: string, value: unknown) => ({ kind, id, revision, value });
  const part = (ordinal: number, text: string) =>
    entity('message-part', `msg_assistant/${ordinal}`, {
      messageID: 'msg_assistant',
      ordinal,
      position: 3,
      part: { type: 'text', text },
    });
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        version: 1,
        sessionID: session.sessionId,
        revision,
        position,
        deleted: false,
      })
    )
    .mockResolvedValueOnce(
      Response.json({
        version: 1,
        sessionID: session.sessionId,
        revision,
        position,
        next: null,
        entities: [
          entity('session', session.sessionId, {
            id: session.sessionId,
            origin: { directory: '/workspace' },
            title: 'Transcript',
            time: { created: 1, updated: 2 },
          }),
          entity('message', 'msg_assistant', {
            seq: 1,
            message: { id: 'msg_assistant', type: 'assistant', time: { created: 2 } },
            parts: { count: 2, through: position },
          }),
          part(10, 'second'),
          part(2, 'first'),
        ],
      })
    );

  await expect(fetchSessionTranscript(session)).resolves.toMatchObject({
    source: 'sync',
    messages: [
      {
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ],
  });
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    `https://sync.test${path}`,
    `https://sync.test${path}/entities?revision=1&limit=100`,
  ]);
  const authorization = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization');
  expect(authorization).toMatch(/^SessionTranscript /);
  expect(decodeJwt(authorization?.split(' ')[1] ?? '')).toMatchObject({
    sub: session.userId,
    aud: 'session-sync:transcript',
    sessionID: session.sessionId,
    organizationID: session.organizationId,
  });
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
