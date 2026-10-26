import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import {
  findActiveDeviceSession,
  isActiveDeviceSession,
  type DeviceSessionDb,
} from './device-session-auth';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));

function fakeDb(rows: unknown[] | Error) {
  const limit = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit }) }),
  }));
  return { db: { select } as unknown as DeviceSessionDb, select, limit };
}

describe('isActiveDeviceSession', () => {
  const deviceSessionId = '11111111-1111-4111-8111-111111111111';

  it('accepts a row owned by the user and not revoked', async () => {
    const { db, limit } = fakeDb([{ id: deviceSessionId }]);

    await expect(isActiveDeviceSession(db, deviceSessionId, 'user-1')).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('rejects missing, revoked and foreign-owner rows alike', async () => {
    const { db } = fakeDb([]);

    await expect(isActiveDeviceSession(db, deviceSessionId, 'user-1')).resolves.toBe(false);
  });

  it('rejects a malformed id without querying', async () => {
    const { db, select } = fakeDb([{ id: 'unexpected' }]);

    await expect(isActiveDeviceSession(db, 'not-a-uuid', 'user-1')).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('propagates lookup failures', async () => {
    const { db } = fakeDb(new Error('connection refused'));

    await expect(isActiveDeviceSession(db, deviceSessionId, 'user-1')).rejects.toThrow(
      'connection refused'
    );
  });
});

describe('findActiveDeviceSession', () => {
  const connectionString = 'postgres://localhost/test';
  const deviceSessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.mocked(getWorkerDb).mockReset();
  });

  it('bounds connections and queries without startup parameters', async () => {
    const { db } = fakeDb([{ id: deviceSessionId }]);
    vi.mocked(getWorkerDb).mockReturnValue(db as ReturnType<typeof getWorkerDb>);

    await expect(
      findActiveDeviceSession(connectionString, deviceSessionId, 'user-1')
    ).resolves.toBe(true);
    expect(getWorkerDb).toHaveBeenCalledExactlyOnceWith(connectionString, {
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
    });
  });

  it('propagates query timeouts as dependency failures', async () => {
    const timeout = new Error('Query read timeout');
    const { db } = fakeDb(timeout);
    vi.mocked(getWorkerDb).mockReturnValue(db as ReturnType<typeof getWorkerDb>);

    await expect(findActiveDeviceSession(connectionString, deviceSessionId, 'user-1')).rejects.toBe(
      timeout
    );
  });
});
