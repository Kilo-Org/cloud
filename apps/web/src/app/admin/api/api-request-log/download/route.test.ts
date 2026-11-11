import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { api_request_log, kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import {
  apiRequestLogBlobSchema,
  uploadApiRequestLogBlobs,
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

async function downloadEntries() {
  const response = await GET(createRequest());
  expect(response.status).toBe(200);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

const baseRow = {
  created_at: '2026-08-01T12:00:00.000Z',
  kilo_user_id: TEST_USER_ID,
  provider: 'test-provider',
  model: TEST_MODEL,
};

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
    await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, TEST_USER_ID));
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
    const request_r2_key = '2026-08-01/access/request.json';
    fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ access: true }));
    await db.insert(api_request_log).values({ ...baseRow, request_r2_key });
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
    const organizationId = 'e6ac973c-5536-466a-b6d2-a966e1ce7521';
    const sensitiveText =
      'https://customer.example/private?email=customer@example.com&token=secret';
    const request_r2_key = '2026-08-01/audit/request.json';
    fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ payload: sensitiveText }));
    const [row] = await db
      .insert(api_request_log)
      .values({
        ...baseRow,
        organization_id: organizationId,
        model: sensitiveText,
        session_id: sensitiveText,
        status_code: 500,
        request_r2_key,
      })
      .returning({ id: api_request_log.id });
    const request = createRequest({
      id: String(row.id),
      organizationId,
      model: sensitiveText,
      session_id: sensitiveText,
      startTime: '12:00',
      endTime: '12:30',
      errorsOnly: 'true',
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
          logId: String(row.id),
          userId: TEST_USER_ID,
          organizationId,
          startAt: '2026-08-01T12:00:00.000Z',
          endAt: '2026-08-01T12:30:59.999Z',
          hasUserFilter: true,
          hasOrganizationFilter: true,
          hasModelPrefixFilter: true,
          hasSessionFilter: true,
          errorsOnly: true,
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
    const organizationId = 'e6ac973c-5536-466a-b6d2-a966e1ce7521';
    await db.insert(api_request_log).values({ ...baseRow, organization_id: organizationId });

    const response = await GET(createRequest({ userId: '', organizationId }));

    expect(response.status).toBe(200);
    expect(mockedRecordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { type: 'organization', id: organizationId },
        metadata: expect.objectContaining({ userId: null, organizationId, hasUserFilter: false }),
      })
    );
    await response.arrayBuffer();
  });

  it.each(['oauth/google:114000741928328149731', 'oauth/github|owner'])(
    'retains user attribution for OAuth ID %s and email filters',
    async userId => {
      const owner = await insertTestUser({ id: userId });
      const organizationId = 'e6ac973c-5536-466a-b6d2-a966e1ce7521';
      await db
        .insert(api_request_log)
        .values({ ...baseRow, kilo_user_id: owner.id, organization_id: organizationId });

      try {
        for (const filter of [owner.id, owner.google_user_email]) {
          mockedRecordAdminAction.mockClear();
          const response = await GET(createRequest({ userId: filter, organizationId }));

          expect(response.status).toBe(200);
          await response.arrayBuffer();
          expect(mockedRecordAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              target: { type: 'user', id: owner.id },
              metadata: expect.objectContaining({ userId: owner.id, organizationId }),
            })
          );
          expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(
            owner.google_user_email
          );
        }
      } finally {
        await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, owner.id));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, owner.id));
      }
    }
  );

  it('does not copy free-form user or organization filters into the audit entry', async () => {
    const sensitiveText = 'https://customer.example/private?email=customer@example.com';
    const userId = 'https://customer.example/private?token=secret';
    await db.insert(api_request_log).values({
      ...baseRow,
      kilo_user_id: userId,
      organization_id: sensitiveText,
    });

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
      await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, userId));
    }
  });

  it('exports combined request and response bodies with a single R2 GET and DB-sourced error', async () => {
    const key = '2026-08-01/combined/log.json';
    const request = { messages: [{ role: 'user', content: 'hello' }] };
    const response = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    const error = { response_body_read_error: 'upstream disconnected' };
    fakeR2.objects.set(`${BUCKET}/${key}`, JSON.stringify({ version: 1, request, response }));
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, request_r2_key: key, response_r2_key: key, error })
      .returning({ id: api_request_log.id });
    const send = jest.spyOn(fakeR2, 'send');

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(3);
    expect(readEntry(entries, `_${row.id}_request.json`)).toBe(JSON.stringify(request, null, 2));
    expect(readEntry(entries, `_${row.id}_response.txt`)).toBe(response);
    expect(JSON.parse(readEntry(entries, `_${row.id}_error.json`))).toEqual(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    expect(send.mock.calls[0][0]).toMatchObject({ input: { Bucket: BUCKET, Key: key } });
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
        part: 'conversation',
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
      {
        guardrail: 'output',
        scan: 'log_only',
        part: 'response',
        request: outputRequest,
        response: '{"summary":{"toxicity":0}}',
        status_code: 200,
        error: null,
      },
    ];
    const send = jest.spyOn(fakeR2, 'send');

    const upload = await uploadApiRequestLogBlobs({ request, response, enkrypt });

    expect(upload.uploadError).toBeNull();
    expect(upload.columns.request_r2_key).toEqual(expect.stringMatching(/\/record\.v1\.json$/));
    expect(upload.columns.response_r2_key).toBe(upload.columns.request_r2_key);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const body = fakeR2.objects.get(`${BUCKET}/${upload.columns.request_r2_key}`);
    if (!body) throw new Error('Missing uploaded envelope');
    expect(JSON.parse(body)).toEqual({ version: 1, request, response, enkrypt });
    expect(apiRequestLogBlobSchema.parse(JSON.parse(body)).enkrypt).toEqual(enkrypt);
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, ...upload.columns })
      .returning({ id: api_request_log.id, created_at: api_request_log.created_at });
    send.mockClear();

    const entries = await downloadEntries();

    const timestamp = row.created_at.replaceAll(':', '-').replaceAll(' ', '_');
    expect(Object.keys(entries)).toEqual([
      `${timestamp}_${row.id}_request.json`,
      `${timestamp}_${row.id}_response.txt`,
      `${timestamp}_${row.id}_enkrypt.json`,
    ]);
    expect(readEntry(entries, `_${row.id}_request.json`)).toBe(JSON.stringify(request, null, 2));
    expect(readEntry(entries, `_${row.id}_response.txt`)).toBe(response);
    expect(readEntry(entries, `_${row.id}_enkrypt.json`)).toBe(JSON.stringify(enkrypt, null, 2));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
  });

  it.each([undefined, []])(
    'omits empty Enkrypt uploads (%j) from the version-1 envelope',
    async enkrypt => {
      const request = { request: true };
      const send = jest.spyOn(fakeR2, 'send');

      const upload = await uploadApiRequestLogBlobs({ request, response: undefined, enkrypt });

      expect(upload.uploadError).toBeNull();
      expect(upload.columns.response_r2_key).toBe(upload.columns.request_r2_key);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      const body = fakeR2.objects.get(`${BUCKET}/${upload.columns.request_r2_key}`);
      if (!body) throw new Error('Missing uploaded envelope');
      expect(JSON.parse(body)).toEqual({ version: 1, request, response: null });
    }
  );

  it.each([undefined, []])(
    'omits the Enkrypt export when the persisted array is absent or empty (%j)',
    async enkrypt => {
      const key = '2026-08-01/no-enkrypt/log.json';
      const request = { request: true };
      const response = '{"response":true}';
      fakeR2.objects.set(
        `${BUCKET}/${key}`,
        JSON.stringify({ version: 1, request, response, enkrypt })
      );
      const [row] = await db
        .insert(api_request_log)
        .values({ ...baseRow, request_r2_key: key, response_r2_key: key })
        .returning({ id: api_request_log.id });
      const send = jest.spyOn(fakeR2, 'send');

      const entries = await downloadEntries();

      expect(Object.keys(entries)).toHaveLength(2);
      expect(readEntry(entries, `_${row.id}_request.json`)).toBe(JSON.stringify(request, null, 2));
      expect(readEntry(entries, `_${row.id}_response.json`)).toBe(
        JSON.stringify({ response: true }, null, 2)
      );
      expect(Object.keys(entries).some(name => name.endsWith('_enkrypt.json'))).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it('omits the response file for a combined log with a null response', async () => {
    const key = '2026-08-01/no-response/log.json';
    fakeR2.objects.set(
      `${BUCKET}/${key}`,
      JSON.stringify({ version: 1, request: { request: true }, response: null })
    );
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, request_r2_key: key, response_r2_key: key })
      .returning({ id: api_request_log.id });
    const send = jest.spyOn(fakeR2, 'send');

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toEqual([expect.stringContaining(`_${row.id}_request.json`)]);
    expect(JSON.parse(readEntry(entries, `_${row.id}_request.json`))).toEqual({ request: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('exports DB errors without R2 reads when upload failure leaves both keys null', async () => {
    const error = { r2_upload_error: 'R2 unavailable' };
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, request_r2_key: null, response_r2_key: null, error })
      .returning({ id: api_request_log.id });
    const send = jest.spyOn(fakeR2, 'send');

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toEqual([expect.stringContaining(`_${row.id}_error.json`)]);
    expect(JSON.parse(readEntry(entries, `_${row.id}_error.json`))).toEqual(error);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', 'private-invalid-json-body'],
    [
      'unsupported version',
      JSON.stringify({ version: 2, request: { content: 'private' }, response: null }),
    ],
    ['string request', JSON.stringify({ version: 1, request: 'private', response: null })],
    ['array request', JSON.stringify({ version: 1, request: ['private'], response: null })],
    ['null request', JSON.stringify({ version: 1, request: null, response: null })],
    [
      'non-string response',
      JSON.stringify({ version: 1, request: { content: 'private' }, response: {} }),
    ],
    ['missing response', JSON.stringify({ version: 1, request: { content: 'private' } })],
    [
      'non-array Enkrypt calls',
      JSON.stringify({ version: 1, request: { content: 'private' }, response: null, enkrypt: {} }),
    ],
    [
      'malformed Enkrypt call',
      JSON.stringify({
        version: 1,
        request: { content: 'private' },
        response: null,
        enkrypt: [{ guardrail: 'input' }],
      }),
    ],
  ])(
    'records load errors for a combined log with %s without exposing its payload',
    async (_, body) => {
      const key = '2026-08-01/malformed/log.json';
      fakeR2.objects.set(`${BUCKET}/${key}`, body);
      const [row] = await db
        .insert(api_request_log)
        .values({ ...baseRow, request_r2_key: key, response_r2_key: key })
        .returning({ id: api_request_log.id });
      const send = jest.spyOn(fakeR2, 'send');

      const entries = await downloadEntries();

      expect(Object.keys(entries)).toHaveLength(2);
      for (const kind of ['request', 'response']) {
        const content = readEntry(entries, `_${row.id}_${kind}_load-error.txt`);
        expect(content).toBe(`Failed to decode ${key} from R2: Invalid API request log envelope`);
        expect(content).not.toContain('private');
      }
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it('records load errors for a missing combined object without aborting other rows', async () => {
    const key = '2026-08-01/missing/log.json';
    const error = { response_body_read_error: 'upstream disconnected' };
    const [missing, present] = await db
      .insert(api_request_log)
      .values([
        { ...baseRow, request_r2_key: key, response_r2_key: key, error },
        { ...baseRow, request_r2_key: 'legacy/request.json' },
      ])
      .returning({ id: api_request_log.id });
    fakeR2.objects.set(`${BUCKET}/legacy/request.json`, '{"legacy":true}');
    const send = jest.spyOn(fakeR2, 'send');

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(4);
    for (const kind of ['request', 'response']) {
      expect(readEntry(entries, `_${missing.id}_${kind}_load-error.txt`)).toBe(
        `Failed to load ${key} from R2: Object not found`
      );
    }
    expect(JSON.parse(readEntry(entries, `_${missing.id}_error.json`))).toEqual(error);
    expect(JSON.parse(readEntry(entries, `_${present.id}_request.json`))).toEqual({ legacy: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(['GET', 'body read'])(
    'records a combined object %s failure for both bodies with a single R2 GET',
    async failure => {
      const key = '2026-08-01/unreadable/log.json';
      await db.insert(api_request_log).values({
        ...baseRow,
        request_r2_key: key,
        response_r2_key: key,
      });
      const send = fakeR2.send.bind(fakeR2);
      const sendSpy = jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
        if (command instanceof GetObjectCommand && command.input.Key === key) {
          if (failure === 'GET') {
            throw new Error('R2 GET failed');
          }
          return {
            Body: {
              transformToString: async () => {
                throw new Error('R2 body read failed');
              },
            },
          };
        }
        return send(command);
      });

      const entries = await downloadEntries();

      expect(Object.keys(entries)).toHaveLength(2);
      for (const kind of ['request', 'response']) {
        expect(readEntry(entries, `_${kind}_load-error.txt`)).toBe(
          `Failed to load ${key} from R2: Error: R2 ${failure} failed`
        );
      }
      expect(sendSpy).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['request', 'response'] as const)(
    'retains the raw legacy %s body when only that key is populated',
    async kind => {
      const key = `2026-08-01/partial/${kind}.json`;
      const body = { version: 1, request: 'legacy body, not an envelope', response: null };
      fakeR2.objects.set(`${BUCKET}/${key}`, JSON.stringify(body));
      const [row] = await db
        .insert(api_request_log)
        .values({
          ...baseRow,
          request_r2_key: kind === 'request' ? key : null,
          response_r2_key: kind === 'response' ? key : null,
        })
        .returning({ id: api_request_log.id });
      const send = jest.spyOn(fakeR2, 'send');

      const entries = await downloadEntries();

      expect(Object.keys(entries)).toEqual([expect.stringContaining(`_${row.id}_${kind}.json`)]);
      expect(JSON.parse(readEntry(entries, `_${row.id}_${kind}.json`))).toEqual(body);
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it('streams a complete ZIP of R2-backed bodies across backpressured DB batches', async () => {
    // The first batch must exceed both the Node and web stream queues. This
    // keeps page two blocked until the test starts consuming the response.
    const payload = randomBytes(128 * 1024).toString('base64');
    const values = Array.from({ length: BATCH_SIZE + 1 }, (_, index) => {
      const request_r2_key = `2026-08-01/row-${index}/request.json`;
      const response_r2_key = `2026-08-01/row-${index}/response.txt`;
      fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ index }));
      fakeR2.objects.set(
        `${BUCKET}/${response_r2_key}`,
        JSON.stringify({ output: index, payload })
      );
      return { ...baseRow, request_r2_key, response_r2_key };
    });
    const rows = await db
      .insert(api_request_log)
      .values(values)
      .returning({ id: api_request_log.id });

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
    expect(readEntry(entries, `_${rows[0].id}_request.json`)).toBe(
      JSON.stringify({ index: 0 }, null, 2)
    );
    expect(JSON.parse(readEntry(entries, `_${rows[BATCH_SIZE].id}_response.json`))).toEqual({
      output: BATCH_SIZE,
      payload,
    });
  });

  it.each(['1', '9007199254740993', '9223372036854775807'])(
    'downloads only the requested log ID %s without requiring other filters',
    async id => {
      const rows = [id, id === '1' ? '2' : String(BigInt(id) - BigInt(1))];
      await db.insert(api_request_log).values(
        rows.map(rowId => {
          const request_r2_key = `2026-08-01/id-${rowId}/request.json`;
          fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ id: rowId }));
          return { ...baseRow, id: BigInt(rowId), request_r2_key };
        })
      );

      const params = new URLSearchParams({ id });
      const response = await GET(
        new NextRequest(`http://localhost:3000/admin/api/api-request-log/download?${params}`)
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toContain(`_id-${id}.zip`);
      expect(mockedRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          target: null,
          metadata: expect.objectContaining({ logId: id, hasUserFilter: false }),
        })
      );
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(entries)).toHaveLength(1);
      expect(JSON.parse(readEntry(entries, `_${id}_request.json`))).toEqual({ id });
    }
  );

  it.each<Record<string, string>>([
    { userId: 'another-user' },
    { organizationId: 'another-organization' },
    { model: 'another-model' },
    { sessionId: 'another-session' },
    { startTime: '13:00' },
    { endTime: '11:00' },
    { errorsOnly: 'true' },
  ])('combines the log ID with the other filters %j', async overrides => {
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, status_code: 200 })
      .returning({ id: api_request_log.id });

    const response = await GET(createRequest({ id: String(row.id), ...overrides }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No records found for the given criteria' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  describe('when filtering by organization and model prefix', () => {
    const rowsByName = {
      sonnetInOrg: { model: 'anthropic/claude-sonnet-4.5', organization_id: 'org-1' },
      opusInOtherOrg: { model: 'anthropic/claude-opus-4.1', organization_id: 'org-2' },
      gptInOrg: { model: 'openai/gpt-5', organization_id: 'org-1' },
      lookalikeInOrg: { model: 'anthropicx/claude', organization_id: 'org-1' },
    };

    async function insertRows() {
      const rows = await db
        .insert(api_request_log)
        .values(
          Object.entries(rowsByName).map(([name, row]) => {
            const request_r2_key = `2026-08-01/${name}/request.json`;
            fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ name }));
            return { ...baseRow, ...row, request_r2_key };
          })
        )
        .returning({ id: api_request_log.id, model: api_request_log.model });
      return new Map(rows.map(row => [row.model, String(row.id)]));
    }

    async function exportedIds(overrides: Record<string, string>) {
      const response = await GET(createRequest(overrides));
      expect(response.status).toBe(200);
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      return Object.keys(entries)
        .map(name => name.match(/_(\d+)_request\.json$/)?.[1])
        .sort();
    }

    it('matches models by prefix', async () => {
      const ids = await insertRows();

      expect(await exportedIds({ model: 'anthropic/' })).toEqual(
        [ids.get(rowsByName.sonnetInOrg.model), ids.get(rowsByName.opusInOtherOrg.model)].sort()
      );
    });

    it('filters by organization ID and names the file after it', async () => {
      const ids = await insertRows();

      const response = await GET(createRequest({ organizationId: 'org-1', model: 'anthropic/' }));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toBe(
        'attachment; filename="api-request-log_api-request-log-download-test-user_org-org-1_2026-08-01_2026-08-01_anthropic-.zip"'
      );
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(entries)).toEqual([
        expect.stringContaining(`_${ids.get(rowsByName.sonnetInOrg.model)}_request.json`),
      ]);
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

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    '1e3',
    'abc',
    ' 1 ',
    '01',
    '9223372036854775808',
    '100000000000000000000',
  ])('rejects invalid log ID %j', async id => {
    const response = await GET(createRequest({ id }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid log ID. Use an integer between 1 and 9223372036854775807.',
    });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  it('filters by UTC start and end time, including the whole end minute', async () => {
    const createdAts = [
      '2026-08-01T09:59:59.999Z',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:30:59.999Z',
      '2026-08-01T10:31:00.000Z',
    ];
    const rows = await db
      .insert(api_request_log)
      .values(
        createdAts.map((created_at, index) => {
          const request_r2_key = `2026-08-01/time-${index}/request.json`;
          fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ index }));
          return { ...baseRow, created_at, request_r2_key };
        })
      )
      .returning({ id: api_request_log.id });

    const response = await GET(createRequest({ startTime: '10:00', endTime: '10:30' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="api-request-log_api-request-log-download-test-user_2026-08-01T10-00_2026-08-01T10-30_poolside-laguna-s-2.1-free.zip"'
    );
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const exportedIds = Object.keys(entries).map(name => name.match(/_(\d+)_request\.json$/)?.[1]);
    expect(exportedIds.sort()).toEqual([String(rows[1].id), String(rows[2].id)].sort());
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

  it('treats an empty time as the whole day', async () => {
    const request_r2_key = '2026-08-01/empty-time/request.json';
    fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ empty: true }));
    await db.insert(api_request_log).values({
      ...baseRow,
      created_at: '2026-08-01T23:59:00.000Z',
      request_r2_key,
    });

    const response = await GET(createRequest({ startTime: '', endTime: '' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="api-request-log_api-request-log-download-test-user_2026-08-01_2026-08-01_poolside-laguna-s-2.1-free.zip"'
    );
  });

  describe('when filtering by user email', () => {
    const TEST_EMAIL = 'api-request-log-download-test-user@example.com';

    afterEach(async () => {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, TEST_USER_ID));
    });

    it('downloads the logs of the user with that email', async () => {
      await insertTestUser({ id: TEST_USER_ID, google_user_email: TEST_EMAIL });
      const request_r2_key = '2026-08-01/email/request.json';
      fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ email: true }));
      const [row] = await db
        .insert(api_request_log)
        .values({ ...baseRow, request_r2_key })
        .returning({ id: api_request_log.id });

      const response = await GET(createRequest({ userId: TEST_EMAIL }));

      expect(response.status).toBe(200);
      expect(mockedRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          target: { type: 'user', id: TEST_USER_ID },
          metadata: expect.objectContaining({ userId: TEST_USER_ID }),
        })
      );
      expect(JSON.stringify(mockedRecordAdminAction.mock.calls)).not.toContain(TEST_EMAIL);
      expect(response.headers.get('Content-Disposition')).toBe(
        'attachment; filename="api-request-log_api-request-log-download-test-user-example.com_2026-08-01_2026-08-01_poolside-laguna-s-2.1-free.zip"'
      );
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(JSON.parse(readEntry(entries, `_${row.id}_request.json`))).toEqual({ email: true });
    });

    it('matches the email case-insensitively', async () => {
      await insertTestUser({ id: TEST_USER_ID, google_user_email: TEST_EMAIL });
      await db.insert(api_request_log).values(baseRow);

      const response = await GET(createRequest({ userId: TEST_EMAIL.toUpperCase() }));

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
    });

    it('rejects an email that matches several users case-insensitively', async () => {
      const otherUserId = `${TEST_USER_ID}-other`;
      await insertTestUser({ id: TEST_USER_ID, google_user_email: TEST_EMAIL });
      await insertTestUser({ id: otherUserId, google_user_email: TEST_EMAIL.toUpperCase() });
      await db.insert(api_request_log).values(baseRow);

      try {
        const response = await GET(
          createRequest({ userId: 'Api-Request-Log-Download-Test-User@Example.com' })
        );

        expect(response.status).toBe(400);
        expect(mockedRecordAdminAction).not.toHaveBeenCalled();
      } finally {
        await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUserId));
      }
    });

    it('reports an unknown email', async () => {
      await db.insert(api_request_log).values(baseRow);

      const response = await GET(createRequest({ userId: TEST_EMAIL }));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `No user found with email ${TEST_EMAIL}` });
      expect(mockedRecordAdminAction).not.toHaveBeenCalled();
    });
  });

  it('rejects a start after the end', async () => {
    const response = await GET(createRequest({ startTime: '11:00', endTime: '10:00' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Start must be before end.' });
    expect(mockedRecordAdminAction).not.toHaveBeenCalled();
  });

  describe('when the export reaches its time budget', () => {
    const ROUTE_BATCH_SIZE = 10;
    const INCOMPLETE_NOTICE_NAME = 'INCOMPLETE_EXPORT_README.txt';

    async function insertRows(length: number) {
      return db
        .insert(api_request_log)
        .values(
          Array.from({ length }, (_, index) => {
            const request_r2_key = `2026-08-01/budget-${index}/request.json`;
            fakeR2.objects.set(`${BUCKET}/${request_r2_key}`, JSON.stringify({ index }));
            return { ...baseRow, request_r2_key };
          })
        )
        .returning({ id: api_request_log.id });
    }

    function exceedBudgetDuringFirstBatch() {
      const realNow = Date.now.bind(Date);
      let offsetMs = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
      const send = fakeR2.send.bind(fakeR2);
      jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
        if (
          command instanceof GetObjectCommand &&
          command.input.Key === '2026-08-01/budget-0/request.json'
        ) {
          offsetMs = 800_000;
        }
        return send(command);
      });
    }

    function exportedIds(entries: Record<string, Uint8Array>) {
      return Object.keys(entries)
        .map(name => name.match(/_(\d+)_request\.json$/)?.[1])
        .filter(id => id !== undefined);
    }

    it('stops after the current batch and explains that the ZIP is incomplete', async () => {
      const rows = await insertRows(ROUTE_BATCH_SIZE + 5);
      exceedBudgetDuringFirstBatch();

      const entries = await downloadEntries();

      expect(exportedIds(entries).sort()).toEqual(
        rows
          .slice(0, ROUTE_BATCH_SIZE)
          .map(row => String(row.id))
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
      exceedBudgetDuringFirstBatch();

      const entries = await downloadEntries();

      expect(exportedIds(entries)).toHaveLength(rows.length);
      expect(entries[INCOMPLETE_NOTICE_NAME]).toBeUndefined();
    });
  });

  it('skips missing R2 objects and records R2 read failures without aborting the export', async () => {
    const [missing, failing] = await db
      .insert(api_request_log)
      .values([
        {
          ...baseRow,
          request_r2_key: 'missing/request.json',
          response_r2_key: 'missing/response.txt',
        },
        {
          ...baseRow,
          request_r2_key: 'failing/request.json',
          response_r2_key: null,
          error: { response_body_read_error: 'upstream disconnected' },
        },
      ])
      .returning({ id: api_request_log.id });
    const send = fakeR2.send.bind(fakeR2);
    jest.spyOn(fakeR2, 'send').mockImplementation(async command => {
      if (command instanceof GetObjectCommand && command.input.Key === 'failing/request.json') {
        throw new Error('R2 unavailable');
      }
      return send(command);
    });

    const entries = await downloadEntries();

    expect(Object.keys(entries).filter(name => name.includes(`_${missing.id}_`))).toEqual([]);
    expect(readEntry(entries, `_${failing.id}_request_load-error.txt`)).toBe(
      'Failed to load failing/request.json from R2: Error: R2 unavailable'
    );
    expect(JSON.parse(readEntry(entries, `_${failing.id}_error.json`))).toEqual({
      response_body_read_error: 'upstream disconnected',
    });
  });
});
