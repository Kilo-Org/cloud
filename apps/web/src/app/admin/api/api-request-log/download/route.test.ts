import { GetObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { api_request_log } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';
import type { FakeR2ClientModule } from '@/tests/helpers/fake-r2.helper';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/r2/client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>('@/lib/r2/client');
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const TEST_USER_ID = 'api-request-log-download-test-user';
const TEST_MODEL = 'poolside/laguna-s-2.1:free';
const BATCH_SIZE = 25;
const BUCKET = 'test-api-request-log';

function createRequest() {
  const params = new URLSearchParams({
    userId: TEST_USER_ID,
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    model: TEST_MODEL,
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

  it('exports legacy rows whose bodies are stored inline', async () => {
    const [row] = await db
      .insert(api_request_log)
      .values({ ...baseRow, request: { legacy: true }, response: 'data: legacy\n\n' })
      .returning({ id: api_request_log.id });

    const entries = await downloadEntries();

    expect(Object.keys(entries)).toHaveLength(2);
    expect(readEntry(entries, `_${row.id}_request.json`)).toBe(
      JSON.stringify({ legacy: true }, null, 2)
    );
    expect(readEntry(entries, `_${row.id}_response.txt`)).toBe('data: legacy\n\n');
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
