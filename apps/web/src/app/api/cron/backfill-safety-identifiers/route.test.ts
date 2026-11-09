import { regenerateSafetyIdentifiers } from '@/lib/safety-identifiers';
import { GET, maxDuration } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/safety-identifiers', () => ({
  regenerateSafetyIdentifiers: jest.fn(),
  SAFETY_IDENTIFIER_BACKFILL_ERROR: 'Safety identifier regeneration failed. Retry to resume.',
  SAFETY_IDENTIFIER_WORK_BUDGET_MS: 240_000,
}));

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/backfill-safety-identifiers', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest
    .mocked(regenerateSafetyIdentifiers)
    .mockResolvedValue({ processed: 3, remaining: true, skipped: false });
});
afterEach(() => jest.restoreAllMocks());

test.each([undefined, 'Bearer wrong', 'cron-secret', 'Bearer cron-secret-extra'])(
  'rejects unauthorized cron requests: %s',
  async authorization => {
    expect((await GET(request(authorization))).status).toBe(401);
    expect(regenerateSafetyIdentifiers).not.toHaveBeenCalled();
  }
);

test('fails closed when the cron secret is not configured', async () => {
  const config = jest.requireMock<{ CRON_SECRET: string }>(
    '@kilocode/web-shared/lib/config.server'
  );
  config.CRON_SECRET = '';
  try {
    expect((await GET(request('Bearer '))).status).toBe(401);
    expect(regenerateSafetyIdentifiers).not.toHaveBeenCalled();
  } finally {
    config.CRON_SECRET = 'cron-secret';
  }
});

test('runs within the internal budget and emits the standard success event', async () => {
  const before = Date.now();
  const response = await GET(request('Bearer cron-secret'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ processed: 3, remaining: true, skipped: false });
  const { deadlineAt } = jest.mocked(regenerateSafetyIdentifiers).mock.calls[0][0];
  expect(deadlineAt).toBeGreaterThanOrEqual(before + 240_000);
  expect(deadlineAt - before).toBeLessThan(maxDuration * 1000);
  expect(maxDuration).toBe(300);
  expect(console.info).toHaveBeenCalledWith(
    expect.stringContaining('"job_name":"web.backfill_safety_identifiers"')
  );
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"processed_count":3'));
});

test('treats mutex contention as a successful skipped invocation', async () => {
  jest
    .mocked(regenerateSafetyIdentifiers)
    .mockResolvedValue({ processed: 0, remaining: true, skipped: true });
  const response = await GET(request('Bearer cron-secret'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ skipped: true });
});

test('sanitizes failures in the HTTP response and scheduled event', async () => {
  jest
    .mocked(regenerateSafetyIdentifiers)
    .mockRejectedValue(new Error('synthetic private database input'));
  const response = await GET(request('Bearer cron-secret'));
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain('private');
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"outcome":"failed"'));
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('private');
});
