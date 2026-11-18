import { afterEach, expect, it, vi } from 'vitest';

import { DataRateLimit } from './data-rate-limit';

afterEach(() => vi.restoreAllMocks());

it('charges before the first request and buys exactly ten credits', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  const limit = vi.fn(async () => ({ success: true }));
  const session = new DataRateLimit();
  for (let index = 0; index < 30; index++)
    expect((await session.admit({ limit }, 'user')).ok).toBe(true);
  expect(limit).toHaveBeenCalledTimes(3);
  expect(limit).toHaveBeenCalledWith({ key: 'user' });
});

it('bounds one user across many sessions including each first request', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  let charged = 0;
  const limit = vi.fn(async () => ({ success: ++charged <= 120 }));
  const sessions = Array.from({ length: 150 }, () => new DataRateLimit());
  let admitted = 0;
  for (const session of sessions) {
    if ((await session.admit({ limit }, 'user')).ok) admitted++;
  }
  expect(admitted).toBe(120);
  for (const session of sessions.slice(0, 120)) {
    for (let index = 0; index < 9; index++)
      if ((await session.admit({ limit }, 'user')).ok) admitted++;
  }
  expect(admitted).toBe(1200);
  expect((await sessions[0]!.admit({ limit }, 'user')).ok).toBe(false);
});

it('enforces the instance-local session budget even across users', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  const limit = vi.fn(async () => ({ success: true }));
  const session = new DataRateLimit();
  for (let index = 0; index < 1200; index++)
    expect((await session.admit({ limit }, `user-${index % 2}`)).ok).toBe(true);
  expect(await session.admit({ limit }, 'other')).toMatchObject({
    ok: false,
    error: { code: 'rate_limited', details: { retryAt: 180_000 } },
  });
  expect(limit).toHaveBeenCalledTimes(120);
});

it('expires unused credits at the period boundary', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(179_999);
  const limit = vi.fn(async () => ({ success: true }));
  const session = new DataRateLimit();
  expect((await session.admit({ limit }, 'user')).ok).toBe(true);
  now.mockReturnValue(180_000);
  expect((await session.admit({ limit }, 'user')).ok).toBe(true);
  expect(limit).toHaveBeenCalledTimes(2);
});

it('does not carry a block purchased across the period boundary', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(179_999);
  const limit = vi.fn(async () => {
    now.mockReturnValue(180_000);
    return { success: limit.mock.calls.length === 1 };
  });
  expect((await new DataRateLimit().admit({ limit }, 'user')).ok).toBe(false);
  expect(limit).toHaveBeenCalledTimes(2);
});

it('serializes concurrent purchases without admitting uncharged requests', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  const limit = vi.fn(async () => ({ success: limit.mock.calls.length === 1 }));
  const session = new DataRateLimit();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => session.admit({ limit }, 'user'))
  );
  expect(results.filter(result => result.ok)).toHaveLength(10);
});

it('never shares prepaid credits between users of one organization session', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(120_000);
  const limit = vi.fn(async ({ key }: { key: string }) => ({ success: key === 'allowed' }));
  const session = new DataRateLimit();
  expect((await session.admit({ limit }, 'allowed')).ok).toBe(true);
  expect((await session.admit({ limit }, 'denied')).ok).toBe(false);
});
