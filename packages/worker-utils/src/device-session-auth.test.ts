import { describe, expect, it, vi } from 'vitest';
import { isActiveDeviceSession, type DeviceSessionDb } from './device-session-auth';

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
