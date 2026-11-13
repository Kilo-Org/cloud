import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { api_request_log_2, kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import {
  apiRequestLogBlobKey,
  apiRequestLogBlobSchema,
  uploadApiRequestLogBlob,
  type EnkryptRequestLog,
} from '@kilocode/web-shared/lib/r2/api-request-log';
import { GET } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/admin/admin-action-audit', () => ({
  ...jest.requireActual('@/lib/admin/admin-action-audit'),
  recordAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@kilocode/web-shared/lib/r2/create-client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@kilocode/web-shared/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>(
  '@kilocode/web-shared/lib/r2/create-client'
);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedRecordAdminAction = jest.mocked(recordAdminAction);
const TEST_USER_ID = 'api-request-log-download-test-user';
const TEST_MODEL = 'poolside/laguna-s-2.1:free';
const ORGANIZATION_ID = 'e6ac973c-5536-466a-b6d2-a966e1ce7521';
const BATCH_SIZE = 25;
const BUCKET = 'test-api-request-log';

function createRequest(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    userId: TEST_USER_ID,
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    model: TEST_MODEL,
    ...overrides,
  });
  return new NextRequest(`http://localhost:3000/admin/api/api-request-log/download?${params}`);
}

function readEntry(entries: Record<string, Uint8Array>, suffix: string): string {
  const name = Object.keys(entries).find(entryName => entryName.endsWith(suffix));
  if (!name) throw new Error(`Missing archive entry ending in ${suffix}`);
  return strFromU8(entries[name]);
}

async function downloadEntries(overrides: Record<string, string> = {}) {
  const response = await GET(createRequest(overrides));
  expect(response.status).toBe(200);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

function exportedIds(entries: Record<string, Uint8Array>) {
  return Object.keys(entries)
    .map(name => name.match(/_([0-9a-f-]{36})_request\.json$/)?.[1])
    .filter(id => id !== undefined)
    .sort();
}

type LogRow = typeof api_request_log_2.$inferInsert;

const baseRow = {
  created_at: '2026-08-01T12:00:00.000Z',
  kilo_user_id: TEST_USER_ID,
  requested_model: TEST_MODEL,
};

/** Inserts a log row and, unless `body` is null, stores its blob under the derived R2 key. */
async function insertLog(
  overrides: Partial<LogRow> = {},
  body: string | null = JSON.stringify({
    version: 2,
    request: { request: true },
    response: null,
    error: null,
  })
) {
  const row = { ...baseRow, id: randomUUID(), ...overrides };
  const key = apiRequestLogBlobKey(row);
  if (body !== null) {
    fakeR2.objects.set(`${BUCKET}/${key}`, body);
  }
  await db.insert(api_request_log_2).values(row);
  return { ...row, key };
}

describe('GET /admin/api/api-request-log/download', () => {
  let exporter: User;
  let sessionViewer: User;

  beforeEach(async () => {
    mockedRecordAdminAction.mockClear();
    fakeR2.objects.clear();
    exporter = await insertTestUser({ is_admin: true, can_export_api_request_logs: true });
    sessionViewer = await insertTestUser({ is_admin: true, can_view_sessions: true });
    mockedGetUserFromAuth.mockResolvedValue({ user: exporter, authFailedResponse: null });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(api_request_log_2).where(eq(api_request_log_2.kilo_user_id, TEST_USER_ID));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [exporter.id, sessionViewer.id]));
  });

  it('does not audit an export when authentication fails', async () => {
    const authFailedResponse = NextResponse.json<FailureResult<string>>(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
    mockedGetUserFromAuth.mockResolvedValue({ user: null, authFailedResponse });

    const response = await GET(createRequest());

    expect(response).toBe(authFailedResponse);
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('requires export access, not session viewing, before reading rows or bodies', async () => {
    await insertLog();
    const send = jest.spyOn(fakeR2, 'send');
    mockedGetUserFromAuth.mockResolvedValue({ user: sessionViewer, authFailedResponse: null });

    const response = await GET(createRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'API request log export access required' });
    expect(send).not.toHaveBeenCalled();
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('applies a permission change to a session that is already signed in', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { ...sessionViewer, can_export_api_request_logs: true },
      authFailedResponse: null,
    });

    const response = await GET(createRequest());

    expect(response.status).toBe(403);
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('does not audit an export when the initial row count fails', async () => {
    const error = new Error('Database unavailable');
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw error;
    });

    await expect(GET(createRequest({ userId: '' }))).rejects.toThrow(error);

    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('audits the authorized export start with normalized filters, not request text or payloads', async () => {
    const sensitiveText =
      'https://customer.example/private?email=customer@example.com&token=secret';
    const row = await insertLog(
      {
        organization_id: ORGANIZATION_ID,
        requested_model: sensitiveText,
        generation_id: sensitiveText,
        session_id: sensitiveText,
      },
      JSON.stringify({
        version: 2,
        request: { payload: sensitiveText },
        response: null,
        error: null,
      })
    );
    const request = createRequest({
      id: row.id,
      generationId: sensitiveText,
      organizationId: ORGANIZATION_ID,
      model: sensitiveText,
      session_id: sensitiveText,
      startTime: '12:00',
      endTime: '12:30',
      arbitraryQuery: sensitiveText,
    });
    request.headers.set('authorization', 'Bearer secret');
    request.headers.set('x-forwarded-for', '192.0.2.1');

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockedRecordAdminAction).toHaveBeenCalledTimes(1);
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        user: exporter,
        authViaToken: true,
        ip: '192.0.2.1',
        trpcPath: '/admin/api/api-request-log/download',
      }),
      {
        action: 'api_request_log.download',
        target: { type: 'user', id: TEST_USER_ID },
        message: 'Started API request log ZIP export',
        metadata: {
          logId: row.id,
          hasGenerationIdFilter: true,
          userId: TEST_USER_ID,
          organizationId: ORGANIZATION_ID,
          startAt: '2026-08-01T12:00:00.000Z',
          endAt: '2026-08-01T12:30:59.999Z',
          hasUserFilter: true,
          hasOrganizationFilter: true,
          hasModelPrefixFilter: true,
          hasSessionFilter: true,
          matchingRows: 1,
        },
      }
    );
    expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(sensitiveText);
    expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain('secret');
    await response.arrayBuffer();
    expect(mockedRecordAdminAction).toHaveBeenCalledTimes(1);
  });

  it('targets the organization for an export without a user filter', async () => {
    await insertLog({ organization_id: ORGANIZATION_ID });

    const response = await GET(createRequest({ userId: '', organizationId: ORGANIZATION_ID }));

    expect(response.status).toBe(200);
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { type: 'organization', id: ORGANIZATION_ID },
        metadata: expect.objectContaining({
          userId: null,
          organizationId: ORGANIZATION_ID,
          hasUserFilter: false,
        }),
      })
    );
    await response.arrayBuffer();
  });

  it.each(['oauth/google:114000741928328149731', 'oauth/github|owner'])(
    'retains user attribution for OAuth ID %s and email filters',
    async userId => {
      const owner = await insertTestUser({ id: userId });
      await insertLog({ kilo_user_id: owner.id, organization_id: ORGANIZATION_ID });

      try {
        for (const filter of [owner.id, owner.google_user_email]) {
          mockedRecordAdminAction.mockClear();
          const response = await GET(
            createRequest({ userId: filter, organizationId: ORGANIZATION_ID })
          );

          expect(response.status).toBe(200);
          await response.arrayBuffer();
          expect(mockedRecordAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              target: { type: 'user', id: owner.id },
              metadata: expect.objectContaining({
                userId: owner.id,
                organizationId: ORGANIZATION_ID,
              }),
            })
          );
          expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(
            owner.google_user_email
          );
        }
      } finally {
        await db.delete(api_request_log_2).where(eq(api_request_log_2.kilo_user_id, owner.id));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, owner.id));
      }
    }
  );

  it('does not copy free-form user or organization filters into the audit entry', async () => {
    const sensitiveText = 'https://customer.example/private?email=customer@example.com';
    const userId = 'https://customer.example/private?token=secret';
    await insertLog({ kilo_user_id: userId, organization_id: sensitiveText });

    try {
      const response = await GET(createRequest({ userId, organizationId: sensitiveText }));

      expect(response.status).toBe(200);
      expect(mockedRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          target: null,
          metadata: expect.objectContaining({
            userId: null,
            organizationId: null,
            hasUserFilter: true,
            hasOrganizationFilter: true,
          }),
        })
      );
      expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(sensitiveText);
      expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(userId);
      await response.arrayBuffer();
    } finally {
      await db.delete(api_request_log_2).where(eq(api_request_log_2.kilo_user_id, userId));
    }
  });

  it('reads the blob from the key derived from the creation date and ID', async () => {
    const id = randomUUID();
    const request = { messages: [{ role: 'user', content: 'hello' }] };
    const response = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    const error = { response_body_read_error: 'upstream disconnected' };
    await insertLog(
      { id, created_at: '2026-08-01T23:59:59.999Z' },
      JSON.stringify({ version: 2, request, response, error })
    );
    const send = jest.spyOn(fakeR2, 'send');

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(3);
    expect(readEntry(entries, `_${id}_request.json`)).toBe(JSON.stringify(request, null, 2));
    expect(readEntry(entries, `_${id}_response.txt`)).toBe(response);
    expect(JSON.parse(readEntry(entries, `_${id}_error.json`))).toEqual(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    expect(send.mock.calls[0][0]).toMatchObject({
      input: { Bucket: BUCKET, Key: `2026/08/01/${id}.json` },
    });
  });

  it('derives the key from the UTC date of a PostgreSQL timestamp', () => {
    const id = randomUUID();

    expect(apiRequestLogBlobKey({ id, created_at: '2026-04-29 23:16:12.945123+00' })).toBe(
      `2026/04/29/${id}.json`
    );
    expect(apiRequestLogBlobKey({ id, created_at: '2026-04-30 01:16:12.945+02' })).toBe(
      `2026/04/29/${id}.json`
    );
  });

  it('uploads and exports the full ordered Enkrypt input/output call array, including retries', async () => {
    const request = { messages: [{ role: 'user', content: 'hello' }] };
    const response = 'data: [DONE]\n\n';
    const inputRequest = {
      text: 'hello',
      detectors: { toxicity: { enabled: true, threshold: 0.5 }, custom: ['policy'] },
      user_metadata: { organization_id: 'org-1' },
    };
    const outputRequest = { ...inputRequest, text: 'world' };
    const enkrypt: EnkryptRequestLog[] = [
      {
        guardrail: 'input',
        scan: 'blocking',
        part: 'conversation',
        request: inputRequest,
        response: 'Service unavailable',
        status_code: 503,
        error: 'Enkrypt returned 503',
      },
      {
        guardrail: 'input',
        scan: 'blocking',
        part: 'system',
        chunk: { index: 1, count: 2 },
        request: inputRequest,
        response: '{"summary":{"toxicity":0}}',
        status_code: 200,
        error: null,
      },
      {
        guardrail: 'output',
        scan: 'log_only',
        part: 'response',
        request: outputRequest,
        response: null,
        status_code: null,
        error: 'Enkrypt request timed out',
      },
    ];
    const id = randomUUID();
    const key = apiRequestLogBlobKey({ id, created_at: baseRow.created_at });
    const send = jest.spyOn(fakeR2, 'send');

    const uploadError = await uploadApiRequestLogBlob(key, {
      request,
      response,
      error: null,
      enkrypt,
    });

    expect(uploadError).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const body = fakeR2.objects.get(`${BUCKET}/${key}`);
    if (!body) throw new Error('Missing uploaded envelope');
    expect(JSON.parse(body)).toEqual({ version: 2, request, response, error: null, enkrypt });
    expect(apiRequestLogBlobSchema.parse(JSON.parse(body)).enkrypt).toEqual(enkrypt);
    await db.insert(api_request_log_2).values({ ...baseRow, id });
    send.mockClear();

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toEqual([
      `2026-08-01_12-00-00+00_${id}_request.json`,
      `2026-08-01_12-00-00+00_${id}_response.txt`,
      `2026-08-01_12-00-00+00_${id}_enkrypt.json`,
    ]);
    expect(readEntry(entries, `_${id}_enkrypt.json`)).toBe(JSON.stringify(enkrypt, null, 2));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, []])('omits empty Enkrypt uploads (%j) from the envelope', async enkrypt => {
    const key = `2026/08/01/${randomUUID()}.json`;

    const uploadError = await uploadApiRequestLogBlob(key, {
      request: { request: true },
      response: null,
      error: null,
      enkrypt,
    });

    expect(uploadError).toBeNull();
    expect(JSON.parse(fakeR2.objects.get(`${BUCKET}/${key}`) ?? '')).toEqual({
      version: 2,
      request: { request: true },
      response: null,
      error: null,
    });
  });

  it('returns the upload error instead of throwing', async () => {
    jest.spyOn(fakeR2, 'send').mockRejectedValue(new Error('R2 unavailable'));

    await expect(
      uploadApiRequestLogBlob('2026/08/01/key.json', {
        request: {},
        response: null,
        error: null,
      })
    ).resolves.toBe('Error: R2 unavailable');
  });

  it('omits the response, Enkrypt and error files when the blob has none', async () => {
    const row = await insertLog(
      {},
      JSON.stringify({
        version: 2,
        request: { request: true },
        response: null,
        error: null,
        enkrypt: [],
      })
    );

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toEqual([expect.stringContaining(`_${row.id}_request.json`)]);
  });

  it.each([
    ['invalid JSON', 'private-invalid-json-body'],
    [
      'unsupported version',
      JSON.stringify({ version: 1, request: { content: 'private' }, response: null }),
    ],
    [
      'string request',
      JSON.stringify({ version: 2, request: 'private', response: null, error: null }),
    ],
    [
      'non-string response',
      JSON.stringify({ version: 2, request: { content: 'private' }, response: {}, error: null }),
    ],
    [
      'missing error',
      JSON.stringify({ version: 2, request: { content: 'private' }, response: null }),
    ],
    [
      'malformed Enkrypt call',
      JSON.stringify({
        version: 2,
        request: { content: 'private' },
        response: null,
        error: null,
        enkrypt: [{ guardrail: 'input' }],
      }),
    ],
  ])('records a load error for a blob with %s without exposing its payload', async (_, body) => {
    const row = await insertLog({}, body);

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(1);
    const content = readEntry(entries, `_${row.id}_load-error.txt`);
    expect(content).toBe(`Failed to decode ${row.key} from R2: Invalid API request log envelope`);
    expect(content).not.toContain('private');
  });

  it('records load errors for missing and unreadable blobs without aborting other rows', async () => {
    const missing = await insertLog({}, null);
    const failing = await insertLog();
    const present = await insertLog();
    const send = fakeR2.send.bind(fakeR2);
    jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.Key === failing.key) {
        throw new Error('R2 unavailable');
      }
      return send(command);
    });

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(3);
    expect(readEntry(entries, `_${missing.id}_load-error.txt`)).toBe(
      `Failed to load ${missing.key} from R2: Object not found`
    );
    expect(readEntry(entries, `_${failing.id}_load-error.txt`)).toBe(
      `Failed to load ${failing.key} from R2: Error: R2 unavailable`
    );
    expect(JSON.parse(readEntry(entries, `_${present.id}_request.json`))).toEqual({
      request: true,
    });
  });

  it('streams a complete ZIP of R2-backed bodies across backpressured DB batches', async () => {
    // The first batch must exceed both the Node and web stream queues. This
    // keeps page two blocked until the test starts consuming the response.
    const payload = randomBytes(128 * 1024).toString('base64');
    const rows = [];
    for (let index = 0; index <= BATCH_SIZE; index++) {
      rows.push(
        await insertLog(
          {},
          JSON.stringify({
            version: 2,
            request: { index },
            response: JSON.stringify({ output: index, payload }),
            error: null,
          })
        )
      );
    }

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="api-request-log_api-request-log-download-test-user_2026-08-01_2026-08-01_poolside-laguna-s-2.1-free.zip"'
    );
    expect(mockedRecordAdminAction).toHaveBeenCalledTimes(1);

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = unzipSync(bytes);
    expect(Object.keys(entries)).toHaveLength((BATCH_SIZE + 1) * 2);
    expect(exportedIds(entries)).toEqual(rows.map(row => row.id).sort());
    expect(JSON.parse(readEntry(entries, `_${rows[BATCH_SIZE].id}_response.json`))).toEqual({
      output: BATCH_SIZE,
      payload,
    });
  });

  it('downloads only the requested log ID without requiring other filters', async () => {
    const row = await insertLog();
    await insertLog();

    const params = new URLSearchParams({ id: row.id });
    const response = await GET(
      new NextRequest(`http://localhost:3000/admin/api/api-request-log/download?${params}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain(`_id-${row.id}.zip`);
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: null,
        metadata: expect.objectContaining({ logId: row.id, hasUserFilter: false }),
      })
    );
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(exportedIds(entries)).toEqual([row.id]);
  });

  it('downloads only the requested generation ID', async () => {
    const row = await insertLog({ generation_id: 'gen-1' });
    await insertLog({ generation_id: 'gen-2' });
    await insertLog();

    const entries = await downloadEntries({ generationId: 'gen-1' });

    expect(exportedIds(entries)).toEqual([row.id]);
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ logId: null, hasGenerationIdFilter: true }),
      })
    );
  });

  it('filters by session ID', async () => {
    const inSession = await insertLog({ session_id: 'session-1' });
    await insertLog({ session_id: 'session-2' });
    await insertLog();

    const response = await GET(createRequest({ sessionId: 'session-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('_session-1.zip');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(exportedIds(entries)).toEqual([inSession.id]);
  });

  it.each<Record<string, string>>([
    { userId: 'another-user' },
    { organizationId: 'another-organization' },
    { model: 'another-model' },
    { generationId: 'another-generation' },
    { sessionId: 'another-session' },
    { startTime: '13:00' },
    { endTime: '11:00' },
  ])('combines the log ID with the other filters %j', async overrides => {
    const row = await insertLog({
      generation_id: 'gen-1',
      organization_id: ORGANIZATION_ID,
      session_id: 'session-1',
    });

    const response = await GET(createRequest({ id: row.id, ...overrides }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No records found for the given criteria' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it.each([
    '1',
    'abc',
    ' 6f2a1c9b-4d3e-4f5a-8b7c-1d2e3f4a5b6c',
    '6f2a1c9b4d3e4f5a8b7c1d2e3f4a5b6c',
  ])('rejects invalid log ID %j', async id => {
    const response = await GET(createRequest({ id }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid log ID. Use the usage UUID.' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  describe('when filtering by organization and model prefix', () => {
    const otherOrganizationId = '7d1f0c86-1d6f-4c1b-9d35-8d7a4b2c9e10';

    async function insertRows() {
      const rows = {
        sonnetInOrg: await insertLog({
          requested_model: 'anthropic/claude-sonnet-4.5',
          organization_id: ORGANIZATION_ID,
        }),
        opusInOtherOrg: await insertLog({
          requested_model: 'anthropic/claude-opus-4.1',
          organization_id: otherOrganizationId,
        }),
        gptInOrg: await insertLog({
          requested_model: 'openai/gpt-5',
          organization_id: ORGANIZATION_ID,
        }),
        lookalikeInOrg: await insertLog({
          requested_model: 'anthropicx/claude',
          organization_id: ORGANIZATION_ID,
        }),
      };
      return rows;
    }

    it('matches requested models by prefix', async () => {
      const rows = await insertRows();

      expect(exportedIds(await downloadEntries({ model: 'anthropic/' }))).toEqual(
        [rows.sonnetInOrg.id, rows.opusInOtherOrg.id].sort()
      );
    });

    it('filters by organization ID and names the file after it', async () => {
      const rows = await insertRows();

      const response = await GET(
        createRequest({ organizationId: ORGANIZATION_ID, model: 'anthropic/' })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toBe(
        `attachment; filename="api-request-log_api-request-log-download-test-user_org-${ORGANIZATION_ID}_2026-08-01_2026-08-01_anthropic-.zip"`
      );
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(exportedIds(entries)).toEqual([rows.sonnetInOrg.id]);
    });

    it.each(['anthropic%', 'anthropic_'])(
      'treats LIKE wildcards in the model prefix %j literally',
      async model => {
        await insertRows();

        const response = await GET(createRequest({ model }));

        expect(response.status).toBe(404);
      }
    );
  });

  it('filters by UTC start and end time, including the whole end minute', async () => {
    const rows = [];
    for (const created_at of [
      '2026-08-01T09:59:59.999Z',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:30:59.999Z',
      '2026-08-01T10:31:00.000Z',
    ]) {
      rows.push(await insertLog({ created_at }));
    }

    const response = await GET(createRequest({ startTime: '10:00', endTime: '10:30' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="api-request-log_api-request-log-download-test-user_2026-08-01T10-00_2026-08-01T10-30_poolside-laguna-s-2.1-free.zip"'
    );
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(exportedIds(entries)).toEqual([rows[1].id, rows[2].id].sort());
  });

  it.each([
    [{ startTime: '25:00' }],
    [{ endTime: '10:00:00' }],
    [{ startDate: '', startTime: '10:00' }],
    [{ startDate: '2026/08/01' }],
    [{ startDate: '2026-02-30', endDate: '2026-03-02' }],
  ])('rejects invalid date or time parameters %j', async overrides => {
    const response = await GET(createRequest(overrides));

    expect(response.status).toBe(400);
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('rejects a start after the end', async () => {
    const response = await GET(createRequest({ startTime: '11:00', endTime: '10:00' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Start must be before end.' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  describe('when filtering by user email', () => {
    const TEST_EMAIL = 'api-request-log-download-test-user@example.com';

    afterEach(async () => {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, TEST_USER_ID));
    });

    it('downloads the logs of the user with that email, matched case-insensitively', async () => {
      await insertTestUser({ id: TEST_USER_ID, google_user_email: TEST_EMAIL });
      const row = await insertLog();

      for (const userId of [TEST_EMAIL, TEST_EMAIL.toUpperCase()]) {
        mockedRecordAdminAction.mockClear();
        const response = await GET(createRequest({ userId }));

        expect(response.status).toBe(200);
        expect(mockedRecordAdminAction).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            target: { type: 'user', id: TEST_USER_ID },
            metadata: expect.objectContaining({ userId: TEST_USER_ID }),
          })
        );
        expect(JSON.stringify(mockedRecordAdminAction.mock.calls).toLowerCase()).not.toContain(
          TEST_EMAIL
        );
        const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
        expect(exportedIds(entries)).toEqual([row.id]);
      }
    });

    it('reports an unknown email', async () => {
      await insertLog();

      const response = await GET(createRequest({ userId: TEST_EMAIL }));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `No user found with email ${TEST_EMAIL}` });
      expect(mockedRecordAdminAction).not.toHaveBeenCalled();
    });
  });

  describe('when the export reaches its time budget', () => {
    const ROUTE_BATCH_SIZE = 10;
    const INCOMPLETE_NOTICE_NAME = 'INCOMPLETE_EXPORT_README.txt';

    async function insertRows(length: number) {
      const rows = [];
      for (let index = 0; index < length; index++) {
        rows.push(
          await insertLog({ created_at: `2026-08-01T12:00:${String(index).padStart(2, '0')}.000Z` })
        );
      }
      return rows;
    }

    function exceedBudgetDuringFirstBatch(firstKey: string) {
      const realNow = Date.now.bind(Date);
      let offsetMs = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
      const send = fakeR2.send.bind(fakeR2);
      jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
        if (command instanceof GetObjectCommand && command.input.Key === firstKey) {
          offsetMs = 800_000;
        }
        return send(command);
      });
    }

    it('stops after the current batch and explains that the ZIP is incomplete', async () => {
      const rows = await insertRows(ROUTE_BATCH_SIZE + 5);
      exceedBudgetDuringFirstBatch(rows[0].key);

      const entries = await downloadEntries();

      expect(exportedIds(entries)).toEqual(
        rows
          .slice(0, ROUTE_BATCH_SIZE)
          .map(row => row.id)
          .sort()
      );
      const notice = strFromU8(entries[INCOMPLETE_NOTICE_NAME]);
      expect(notice).toContain('This export is incomplete.');
      expect(notice).toContain(
        `It contains ${ROUTE_BATCH_SIZE} matching records. 5 more matching records were not exported.`
      );
      expect(notice).toContain(`The last exported record has id ${rows[ROUTE_BATCH_SIZE - 1].id}`);
    });

    it('omits the notice when no matching records remain', async () => {
      const rows = await insertRows(ROUTE_BATCH_SIZE);
      exceedBudgetDuringFirstBatch(rows[0].key);

      const entries = await downloadEntries();

      expect(exportedIds(entries)).toHaveLength(rows.length);
      expect(entries[INCOMPLETE_NOTICE_NAME]).toBeUndefined();
    });
  });
});
