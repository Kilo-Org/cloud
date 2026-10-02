import { GetObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { api_request_log } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/r2/client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@kilocode/web-shared/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>('@kilocode/web-shared/lib/r2/client');
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
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
  beforeEach(() => {
    fakeR2.objects.clear();
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, TEST_USER_ID));
  });

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

  it('rejects a start after the end', async () => {
    const response = await GET(createRequest({ startTime: '11:00', endTime: '10:00' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Start must be before end.' });
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
