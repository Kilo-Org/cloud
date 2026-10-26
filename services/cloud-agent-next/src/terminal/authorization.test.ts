import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import { createTerminalAuthorization } from './authorization.js';

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(values.get(key))),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
  let metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { userId: 'user_fixture', sessionId: 'workspace_fixture', orgId: 'org_fixture' },
    auth: { kiloSessionId: 'ses_fixture' },
    agent: { mode: 'code', model: 'test/model' },
    lifecycle: { version: 1, timestamp: 1 },
  });
  const checkAccess = vi.fn(async (): Promise<'allowed' | 'denied' | 'unavailable'> => 'allowed');
  const revokeTerminals = vi.fn(async () => undefined);
  const schedule = vi.fn(async () => undefined);
  const create = () =>
    createTerminalAuthorization({
      storage: storage as unknown as DurableObjectStorage,
      getMetadata: () => metadata,
      checkAccess,
      revokeTerminals,
      schedule,
    });
  return {
    authorization: create(),
    create,
    checkAccess,
    revokeTerminals,
    storage,
    changeOrganization: () => {
      metadata = { ...metadata, identity: { ...metadata.identity, orgId: 'org_other' } };
    },
  };
}

describe('terminal authorization lease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('rechecks access after 30 seconds and persists the lease across eviction', async () => {
    const { authorization, create, checkAccess } = fixture();
    expect(await authorization.ensure()).toBe(true);
    expect(await authorization.nextCheckAt()).toBe(1_030_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await create().ensure()).toBe(true);
    expect(checkAccess).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await authorization.maintain();
    expect(checkAccess).toHaveBeenCalledTimes(2);
    expect(await authorization.nextCheckAt()).toBe(1_060_000);
  });

  it('closes terminals on a denied recheck without waiting for lease expiry', async () => {
    const { authorization, checkAccess, revokeTerminals } = fixture();
    await authorization.ensure();
    checkAccess.mockResolvedValue('denied');
    await vi.advanceTimersByTimeAsync(30_000);
    await authorization.maintain();
    expect(revokeTerminals).toHaveBeenCalledOnce();
    expect(await authorization.ensure()).toBe(false);
    expect(await authorization.nextCheckAt()).toBeNull();
  });

  it('retries a transient check without extending the existing access deadline', async () => {
    const { authorization, checkAccess, revokeTerminals } = fixture();
    await authorization.ensure();
    checkAccess.mockResolvedValue('unavailable');
    await vi.advanceTimersByTimeAsync(30_000);
    await authorization.maintain();
    expect(await authorization.nextCheckAt()).toBe(1_035_000);
    expect(await authorization.ensure()).toBe(true);
    expect(revokeTerminals).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await authorization.ensure()).toBe(false);
    expect(revokeTerminals).toHaveBeenCalledOnce();
  });

  it('recovers from a transient check within the existing lease', async () => {
    const { authorization, checkAccess, revokeTerminals } = fixture();
    await authorization.ensure();
    checkAccess.mockResolvedValueOnce('unavailable');
    await vi.advanceTimersByTimeAsync(30_000);
    await authorization.maintain();
    await vi.advanceTimersByTimeAsync(5_000);
    await authorization.maintain();
    expect(await authorization.nextCheckAt()).toBe(1_065_000);
    expect(revokeTerminals).not.toHaveBeenCalled();
  });

  it('checks expired access on traffic even if no alarm or notification arrives', async () => {
    const { authorization, checkAccess, revokeTerminals } = fixture();
    await authorization.ensure();
    checkAccess.mockResolvedValue('denied');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await authorization.ensure()).toBe(false);
    expect(revokeTerminals).toHaveBeenCalledOnce();
  });

  it('bounds a stalled authorization check', async () => {
    const { authorization, checkAccess, revokeTerminals } = fixture();
    checkAccess.mockImplementation(() => new Promise(() => {}));
    const pending = authorization.ensure();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(false);
    expect(revokeTerminals).toHaveBeenCalledOnce();
  });

  it('does not restore access when a stale successful check finishes after revocation', async () => {
    const { authorization, checkAccess } = fixture();
    const response = Promise.withResolvers<'allowed'>();
    checkAccess.mockReturnValue(response.promise);
    const pending = authorization.ensure();
    await vi.advanceTimersByTimeAsync(0);
    await authorization.revoke();
    response.resolve('allowed');
    expect(await pending).toBe(false);
    expect(await authorization.nextCheckAt()).toBeNull();
  });

  it('denies traffic while revocation storage is pending', async () => {
    const { authorization, storage } = fixture();
    await authorization.ensure();
    const deletion = Promise.withResolvers<boolean>();
    storage.delete.mockReturnValueOnce(deletion.promise);
    const revocation = authorization.revoke();
    expect(await authorization.ensure()).toBe(false);
    deletion.resolve(true);
    await revocation;
  });

  it('removes a stale lease when revocation races with its storage write', async () => {
    const { authorization, storage, checkAccess } = fixture();
    const written = Promise.withResolvers<void>();
    const put = storage.put.getMockImplementation()!;
    storage.put.mockImplementationOnce(async (key, value) => {
      await written.promise;
      await put(key, value);
    });
    const pending = authorization.ensure();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.put).toHaveBeenCalledOnce();
    await authorization.revoke();
    const traffic = authorization.ensure();
    written.resolve();
    expect(await pending).toBe(false);
    expect(await traffic).toBe(false);
    expect(await authorization.nextCheckAt()).toBeNull();
    checkAccess.mockResolvedValue('denied');
    expect(await authorization.ensure()).toBe(false);
  });

  it('does not reuse a lease for another organization', async () => {
    const { authorization, changeOrganization, checkAccess } = fixture();
    await authorization.ensure();
    changeOrganization();
    checkAccess.mockResolvedValue('denied');
    expect(await authorization.ensure()).toBe(false);
  });
});
