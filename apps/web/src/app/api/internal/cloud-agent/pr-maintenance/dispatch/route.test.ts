import { POST } from './route';
import { dispatchWatchPrMaintenance } from '@/lib/cloud-agent/watch-pr-maintenance';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'synthetic-internal-secret',
}));
jest.mock('@/lib/cloud-agent/watch-pr-maintenance', () => ({
  dispatchWatchPrMaintenance: jest.fn(async () => ({ scheduled: [] })),
}));

function request(body: unknown, authorized = true) {
  return new Request('http://localhost/api/internal/cloud-agent/pr-maintenance/dispatch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorized ? { 'x-internal-api-key': 'synthetic-internal-secret' } : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => jest.clearAllMocks());

it('authenticates before parsing or dispatching work', async () => {
  const response = await POST(request({}, false));
  expect(response.status).toBe(401);
  expect(dispatchWatchPrMaintenance).not.toHaveBeenCalled();
});

it.each([
  { limit: 0 },
  { limit: 21 },
  { watchId: 'not-a-uuid' },
  { watchId: 'oauth/example' },
  { unexpected: true },
])('rejects invalid bounded dispatch input %j', async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(dispatchWatchPrMaintenance).not.toHaveBeenCalled();
});

it('accepts a bounded scheduler request and returns durable due work', async () => {
  const watchId = '10000000-0000-4000-8000-000000000001';
  const dueAt = '2026-11-12T12:00:00.000Z';
  jest
    .mocked(dispatchWatchPrMaintenance)
    .mockResolvedValueOnce({ scheduled: [{ watchId, dueAt }], nextDueAt: dueAt });
  const response = await POST(request({ watchId, limit: 20 }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ scheduled: [{ watchId, dueAt }], nextDueAt: dueAt });
  expect(dispatchWatchPrMaintenance).toHaveBeenCalledWith({ watchId, limit: 20 });
});

it('defaults the cron batch to twenty without accepting an owner override', async () => {
  expect((await POST(request({}))).status).toBe(200);
  expect(dispatchWatchPrMaintenance).toHaveBeenCalledWith({ limit: 20 });
});
