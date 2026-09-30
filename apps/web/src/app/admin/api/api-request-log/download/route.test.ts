import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { api_request_log } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { GET } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const TEST_USER_ID = 'api-request-log-download-test-user';
const TEST_MODEL = 'poolside/laguna-s-2.1:free';
const BATCH_SIZE = 25;

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

describe('GET /admin/api/api-request-log/download', () => {
  beforeEach(() => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  afterEach(async () => {
    await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, TEST_USER_ID));
  });

  it('streams a complete ZIP across backpressured DB batches', async () => {
    // The first batch must exceed both the Node and web stream queues. This
    // keeps page two blocked until the test starts consuming the response.
    const payload = randomBytes(128 * 1024).toString('base64');
    const rows = await db
      .insert(api_request_log)
      .values(
        Array.from({ length: BATCH_SIZE + 1 }, (_, index) => ({
          created_at: '2026-08-01T12:00:00.000Z',
          kilo_user_id: TEST_USER_ID,
          provider: 'test-provider',
          model: TEST_MODEL,
          request: { index },
          response: JSON.stringify({ output: index, payload }),
        }))
      )
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
});
