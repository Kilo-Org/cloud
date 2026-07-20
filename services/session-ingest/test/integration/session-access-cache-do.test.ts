import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SESSION_ACCESS_CACHE_TTL_MS } from '../../src/dos/SessionAccessCacheDO';

function getStub(kiloUserId: string) {
  return env.SESSION_ACCESS_CACHE_DO.get(env.SESSION_ACCESS_CACHE_DO.idFromName(kiloUserId));
}

describe('SessionAccessCacheDO integration', () => {
  it('expires validated access after the fixed 60-second authorization window', async () => {
    const stub = getStub('usr_cache_expiry');
    const beforeWrite = Date.now();

    await stub.putValidated({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(stub.getAccess('ses_12345678901234567890123456')).resolves.toEqual({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: '11111111-1111-4111-8111-111111111111',
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const [row] = [
        ...state.storage.sql.exec<{ authorization_expires_at: number }>(
          'SELECT authorization_expires_at FROM sessions WHERE session_id = ?',
          'ses_12345678901234567890123456'
        ),
      ];
      expect(row?.authorization_expires_at).toBeGreaterThanOrEqual(
        beforeWrite + SESSION_ACCESS_CACHE_TTL_MS
      );
      expect(row?.authorization_expires_at).toBeLessThanOrEqual(
        Date.now() + SESSION_ACCESS_CACHE_TTL_MS
      );
      state.storage.sql.exec(
        'UPDATE sessions SET authorization_expires_at = ? WHERE session_id = ?',
        Date.now() - 1,
        'ses_12345678901234567890123456'
      );
    });

    await expect(stub.getAccess('ses_12345678901234567890123456')).resolves.toBeNull();
  });

  it('supports legacy cache checks during mixed-version deployments', async () => {
    const stub = getStub('usr_legacy_cache_check');
    await stub.putValidated({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });

    await expect(stub.has('ses_12345678901234567890123456')).resolves.toBe(true);
  });

  it('does not grant access through the legacy context-free cache write', async () => {
    const stub = getStub('usr_legacy_cache_write');

    await stub.add('ses_12345678901234567890123456');

    await expect(stub.getAccess('ses_12345678901234567890123456')).resolves.toBeNull();
  });

  it('purges expired rows on write so per-user storage stays bounded', async () => {
    const stub = getStub('usr_cache_purge');
    await stub.putValidated({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE sessions SET authorization_expires_at = ? WHERE session_id = ?',
        Date.now() - 1,
        'ses_12345678901234567890123456'
      );
    });

    await stub.putValidated({
      sessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      organizationId: null,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const sessionIds = [
        ...state.storage.sql.exec<{ session_id: string }>('SELECT session_id FROM sessions'),
      ].map(row => row.session_id);
      expect(sessionIds).toEqual(['ses_abcdefghijklmnopqrstuvwxyz']);
    });
  });

  it('invalidates only cached access for the removed organization', async () => {
    const stub = getStub('usr_cache_invalidation');
    await stub.putValidated({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: '11111111-1111-4111-8111-111111111111',
    });
    await stub.putValidated({
      sessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      organizationId: '22222222-2222-4222-8222-222222222222',
    });

    await stub.invalidateOrganization('11111111-1111-4111-8111-111111111111');

    await expect(stub.getAccess('ses_12345678901234567890123456')).resolves.toBeNull();
    await expect(stub.getAccess('ses_abcdefghijklmnopqrstuvwxyz')).resolves.toEqual({
      sessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      organizationId: '22222222-2222-4222-8222-222222222222',
    });
  });
});
