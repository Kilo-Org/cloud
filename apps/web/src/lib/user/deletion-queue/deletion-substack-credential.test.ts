import { eq } from 'drizzle-orm';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import { UserDeletionProviderScope } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  decryptDeletionCredential,
  encryptDeletionCredential,
} from '@/lib/user/deletion-queue/deletion-crypto';
import {
  deleteSubstackCredential,
  getSubstackCredentialMeta,
  getSubstackPublicationUrl,
  parseSubstackCredential,
  persistRefreshedSubstackCookie,
  replaceSubstackCredential,
  serializeSubstackCredential,
  SubstackCredentialInputError,
  testStoredSubstackCredential,
  testSubstackCredentialMaterial,
} from '@/lib/user/deletion-queue/deletion-substack-credential';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('parseSubstackCredential', () => {
  it('builds a sid cookie from JSON sid material', () => {
    expect(parseSubstackCredential('{"sid":"abc123"}')).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=abc123', totpSecret: null },
    });
  });

  it('returns a raw cookie string unchanged', () => {
    expect(parseSubstackCredential('connect.sid=raw-cookie')).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=raw-cookie', totpSecret: null },
    });
  });

  it('uses connect.sid for a bare session value', () => {
    expect(parseSubstackCredential('bare-session-value')).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=bare-session-value', totpSecret: null },
    });
  });

  it('parses and normalizes a cookie with a TOTP secret', () => {
    expect(
      parseSubstackCredential('{"cookie":"connect.sid=abc","totpSecret":"gezd gnbv gy3tqojq"}')
    ).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=abc', totpSecret: 'GEZDGNBVGY3TQOJQ' },
    });
  });

  it('treats a blank TOTP secret as cookie-only', () => {
    expect(parseSubstackCredential('{"cookie":"connect.sid=abc","totpSecret":"  "}')).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=abc', totpSecret: null },
    });
  });

  it('fails closed for a malformed TOTP secret', () => {
    expect(parseSubstackCredential('{"cookie":"connect.sid=abc","totpSecret":"bad!"}')).toEqual({
      ok: false,
      reason: 'invalid_totp',
    });
  });

  it('fails closed for a TOTP secret with non-zero unused trailing bits', () => {
    expect(parseSubstackCredential('{"cookie":"connect.sid=abc","totpSecret":"AB"}')).toEqual({
      ok: false,
      reason: 'invalid_totp',
    });
  });

  it.each(['', '   ', '{', '{"cookie":""}', 'connect.sid=bad\nvalue'])(
    'rejects invalid material %j',
    material => {
      expect(parseSubstackCredential(material)).toEqual({ ok: false, reason: 'invalid_material' });
    }
  );
});

describe('serializeSubstackCredential', () => {
  it('round-trips a cookie-only credential', () => {
    const parsed = parseSubstackCredential(
      serializeSubstackCredential({ cookie: 'a=1', totpSecret: null })
    );
    expect(parsed).toEqual({ ok: true, credential: { cookie: 'a=1', totpSecret: null } });
  });

  it('round-trips a credential with a TOTP secret', () => {
    const parsed = parseSubstackCredential(
      serializeSubstackCredential({ cookie: 'a=1', totpSecret: RFC_SECRET })
    );
    expect(parsed).toEqual({
      ok: true,
      credential: { cookie: 'a=1', totpSecret: RFC_SECRET },
    });
  });
});

describe('testSubstackCredentialMaterial', () => {
  const publication = 'https://newsletter.example.com';
  let replacedEnv: { restore(): void };

  beforeEach(() => {
    replacedEnv = jest.replaceProperty(process, 'env', {
      ...process.env,
      SUBSTACK_PUBLICATION_URL: publication,
    });
  });

  afterEach(() => {
    replacedEnv.restore();
    jest.restoreAllMocks();
  });

  it('returns healthy without a TOTP secret and does not reauthenticate', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ user: { handle: 'jane', name: 'Jane Doe', email: 'secret@example.com' } })
      );

    const outcome = await testSubstackCredentialMaterial('connect.sid=abc123');

    expect(outcome).toEqual({
      result: { status: 'healthy', handle: 'jane', name: 'Jane Doe', totpVerified: false },
      refreshedCookie: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('secret@example.com');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('does not reauthenticate on %s without the marker', async status => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result:
          status === 401
            ? { status: 'expired' }
            : { status: 'error', errorCode: 'substack_forbidden' },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reauthenticate on a nested marker', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: { type: 'reauthentication_required' } }, { status: 403 })
      );

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'error', errorCode: 'substack_forbidden' },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries https://substack.com after a publication 404', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ handle: 'fallback', name: 'Fallback' }));

    await expect(testSubstackCredentialMaterial('sid-only')).resolves.toEqual({
      result: { status: 'healthy', handle: 'fallback', name: 'Fallback', totpVerified: false },
      refreshedCookie: null,
    });
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      'https://substack.com/api/v1/user/profile/self'
    );
  });

  it('does not carry substack.com fallback cookies into the publication session', async () => {
    const calls: Array<{ url: string; cookie: string }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const calledUrl = String(url);
      calls.push({
        url: calledUrl,
        cookie: (init?.headers as Record<string, string> | undefined)?.Cookie ?? '',
      });
      if (calledUrl === `${publication}/api/v1/user/profile/self`) {
        return new Response('', { status: 404 });
      }
      if (calledUrl === 'https://substack.com/api/v1/user/profile/self') {
        return Response.json(
          { handle: 'fallback', name: 'Fallback' },
          { headers: { 'set-cookie': 'connect.sid=other; Domain=.substack.com' } }
        );
      }
      throw new Error(`Unexpected request: ${calledUrl}`);
    });

    const outcome = await testSubstackCredentialMaterial('connect.sid=publication', RFC_SECRET);

    expect(outcome.result).toMatchObject({ status: 'healthy', totpVerified: false });
    expect(outcome.refreshedCookie).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cookie).toBe('connect.sid=publication');
  });

  it('retries the fallback URL without carrying its cookies into the publication session', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          { type: 'reauthentication_required' },
          { status: 403, headers: { 'set-cookie': 'connect.sid=other; Domain=.substack.com' } }
        )
      )
      .mockResolvedValueOnce(
        Response.json({}, { headers: { 'set-cookie': 'session=publication-refreshed' } })
      )
      .mockResolvedValueOnce(
        Response.json(
          { handle: 'fallback', name: 'Fallback' },
          { headers: { 'set-cookie': 'session=fallback; Domain=.substack.com' } }
        )
      );

    await expect(
      testSubstackCredentialMaterial('connect.sid=publication', RFC_SECRET)
    ).resolves.toEqual({
      result: { status: 'healthy', handle: 'fallback', name: 'Fallback', totpVerified: false },
      refreshedCookie: 'connect.sid=publication; session=publication-refreshed',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls[2]?.[0]).toBe(`${publication}/api/v1/reauthenticate/start`);
    expect(fetchSpy.mock.calls[2]?.[1]?.headers).toMatchObject({
      Cookie: 'connect.sid=publication',
    });
    expect(fetchSpy.mock.calls[3]?.[0]).toBe(fetchSpy.mock.calls[1]?.[0]);
    expect(fetchSpy.mock.calls[3]?.[1]?.headers).toMatchObject({
      Cookie: 'connect.sid=publication; session=publication-refreshed',
    });
  });

  it('does not return a cookie from a failed session test', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('', { status: 401, headers: { 'set-cookie': 'connect.sid=; Max-Age=0' } })
      );

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'expired' },
        refreshedCookie: null,
      }
    );
  });

  it.each([401, 403, 404, 409])(
    'reauthenticates only after the explicit marker on %s and retries the profile',
    async status => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status }))
        .mockResolvedValueOnce(
          Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } })
        )
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json({ handle: 'jane', name: 'Jane Doe' }));

      const outcome = await testSubstackCredentialMaterial(
        'connect.sid=abc123',
        `  ${RFC_SECRET.toLowerCase()}  `
      );

      expect(outcome.result).toEqual({
        status: 'healthy',
        handle: 'jane',
        name: 'Jane Doe',
        totpVerified: true,
      });
      expect(outcome.refreshedCookie).toContain('session=rotated');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
        `${publication}/api/v1/user/profile/self`,
        `${publication}/api/v1/reauthenticate/start`,
        `${publication}/api/v1/reauthenticate/complete`,
        `${publication}/api/v1/user/profile/self`,
      ]);
      expect(fetchSpy.mock.calls[3]?.[1]?.headers).toMatchObject({
        Cookie: 'connect.sid=abc123; session=rotated',
      });
    }
  );

  it('makes only one profile request when healthy with TOTP configured', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ handle: 'jane', name: 'Jane Doe' }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'healthy', handle: 'jane', name: 'Jane Doe', totpVerified: false },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reauthenticate for a marker on a successful response', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ type: 'reauthentication_required', handle: 'jane', name: 'Jane Doe' })
      );

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'healthy', handle: 'jane', name: 'Jane Doe', totpVerified: false },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns healthy without claiming TOTP verification when reauth completes without TOTP', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}, { headers: { 'set-cookie': 'session=rotated' } }))
      .mockResolvedValueOnce(Response.json({ handle: 'jane', name: 'Jane Doe' }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'healthy', handle: 'jane', name: 'Jane Doe', totpVerified: false },
        refreshedCookie: 'connect.sid=abc123; session=rotated',
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('returns reauth_required without a configured secret', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123')).resolves.toEqual({
      result: { status: 'error', errorCode: 'substack_reauth_required' },
      refreshedCookie: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns reauth_required after one retry if the challenge persists', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'error', errorCode: 'substack_reauth_required' },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('does not retry the profile after a failed TOTP reauthentication', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(Response.json({ error: 'invalid_code' }));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'error', errorCode: 'substack_reauth_rejected' },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 500])(
    'preserves profile failure classification on retry HTTP %s',
    async status => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          Response.json({ type: 'reauthentication_required' }, { status: 403 })
        )
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json({ error: 'failed' }, { status }));

      await expect(
        testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)
      ).resolves.toEqual({
        result:
          status === 401
            ? { status: 'expired' }
            : { status: 'error', errorCode: status === 403 ? 'substack_forbidden' : 'http_500' },
        refreshedCookie: null,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    }
  );

  it('preserves network failure classification on the profile retry', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'error', errorCode: 'network_error' },
        refreshedCookie: null,
      }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('carries publication cookies through the challenge, reauth, and profile retry', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { type: 'reauthentication_required' },
          { status: 403, headers: { 'set-cookie': 'connect.sid=profile' } }
        )
      )
      .mockResolvedValueOnce(
        Response.json({}, { headers: { 'set-cookie': 'session=reauthenticated' } })
      )
      .mockResolvedValueOnce(
        Response.json(
          { handle: 'jane', name: 'Jane Doe' },
          { headers: { 'set-cookie': 'connect.sid=retried' } }
        )
      );

    await expect(testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)).resolves.toEqual(
      {
        result: { status: 'healthy', handle: 'jane', name: 'Jane Doe', totpVerified: false },
        refreshedCookie: 'connect.sid=retried; session=reauthenticated',
      }
    );
    expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ Cookie: 'connect.sid=profile' });
    expect(fetchSpy.mock.calls[2]?.[1]?.headers).toMatchObject({
      Cookie: 'connect.sid=profile; session=reauthenticated',
    });
  });

  it('rejects an invalid TOTP secret without fetching', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(testSubstackCredentialMaterial('connect.sid=abc123', 'bad!')).resolves.toEqual({
      result: { status: 'error', errorCode: 'substack_totp_invalid' },
      refreshedCookie: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not treat an unsupported reauth method as healthy', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ method: 'email' }));

    await expect(
      testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)
    ).resolves.toMatchObject({
      result: { status: 'error', errorCode: 'substack_reauth_method_unsupported' },
    });
  });

  it('maps a blocked reauth redirect to substack_redirect_blocked', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ type: 'reauthentication_required' }, { status: 403 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch: redirect'));

    await expect(
      testSubstackCredentialMaterial('connect.sid=abc123', RFC_SECRET)
    ).resolves.toMatchObject({
      result: { status: 'error', errorCode: 'substack_redirect_blocked' },
    });
  });
});

describe('Substack credential storage', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    process.env.SUBSTACK_PUBLICATION_URL = 'https://newsletter.example.com';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function storedMaterial(): Promise<string> {
    const [row] = await db
      .select({ encrypted_material: user_deletion_provider_credentials.encrypted_material })
      .from(user_deletion_provider_credentials)
      .where(
        eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
      );
    return decryptDeletionCredential(row.encrypted_material);
  }

  it('stores and reports a TOTP-configured credential', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=abc',
      totpSecret: RFC_SECRET.toLowerCase(),
      actorKiloUserId: actor.id,
    });

    const meta = await getSubstackCredentialMeta();
    expect(meta).toMatchObject({
      configured: true,
      totpConfigured: true,
      updatedByKiloUserId: actor.id,
    });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=abc', totpSecret: RFC_SECRET },
    });
  });

  it('clears a stored TOTP secret when a full replacement has a blank secret', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=abc',
      totpSecret: RFC_SECRET,
      actorKiloUserId: actor.id,
    });
    await replaceSubstackCredential({
      material: 'connect.sid=new',
      totpSecret: '',
      actorKiloUserId: actor.id,
    });

    expect(await getSubstackCredentialMeta()).toMatchObject({
      totpConfigured: false,
      configured: true,
    });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=new', totpSecret: null },
    });
  });

  it('rejects an invalid TOTP secret without echoing it', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const error = await replaceSubstackCredential({
      material: 'connect.sid=abc',
      totpSecret: 'super-secret-bad!',
      actorKiloUserId: actor.id,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(SubstackCredentialInputError);
    expect(String(error.message)).not.toContain('super-secret-bad');
  });

  it('rejects a TOTP secret with non-zero unused trailing bits without echoing it', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const error = await replaceSubstackCredential({
      material: 'connect.sid=abc',
      totpSecret: 'AB',
      actorKiloUserId: actor.id,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(SubstackCredentialInputError);
    expect(String(error.message)).not.toContain('AB');
  });

  it('reports totpConfigured for malformed stored TOTP material', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await db.insert(user_deletion_provider_credentials).values({
      provider_scope: UserDeletionProviderScope.Substack,
      encrypted_material: encryptDeletionCredential(
        JSON.stringify({ cookie: 'connect.sid=abc', totpSecret: 'bad!' })
      ),
      updated_by_kilo_user_id: actor.id,
    });

    expect(await getSubstackCredentialMeta()).toMatchObject({
      configured: true,
      totpConfigured: true,
    });
    await expect(testStoredSubstackCredential()).resolves.toEqual({
      status: 'error',
      errorCode: 'substack_totp_invalid',
    });
  });

  it('persists a refreshed cookie with compare-and-swap preserving the TOTP secret', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      actorKiloUserId: actor.id,
    });
    const [row] = await db
      .select({ encrypted_material: user_deletion_provider_credentials.encrypted_material })
      .from(user_deletion_provider_credentials)
      .where(
        eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
      );

    await expect(
      persistRefreshedSubstackCookie({
        originalEncryptedMaterial: row.encrypted_material,
        cookie: 'connect.sid=old; session=rotated',
        totpSecret: RFC_SECRET,
      })
    ).resolves.toEqual({ persisted: true });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=old; session=rotated', totpSecret: RFC_SECRET },
    });

    await expect(
      persistRefreshedSubstackCookie({
        originalEncryptedMaterial: row.encrypted_material,
        cookie: 'connect.sid=stale',
        totpSecret: RFC_SECRET,
      })
    ).resolves.toEqual({ persisted: false });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=old; session=rotated', totpSecret: RFC_SECRET },
    });
  });

  it('persists a refreshed cookie after a stored TOTP test', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      actorKiloUserId: actor.id,
    });
    let profileRequests = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/profile/self')) {
        if (profileRequests++ === 0) {
          return Response.json({ type: 'reauthentication_required' }, { status: 403 });
        }
        return Response.json({ handle: 'jane', name: 'Jane' });
      }
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      return Response.json({});
    });

    await expect(testStoredSubstackCredential()).resolves.toEqual({
      status: 'healthy',
      handle: 'jane',
      name: 'Jane',
      totpVerified: true,
    });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=old; session=rotated', totpSecret: RFC_SECRET },
    });
  });

  it('returns a safe error when the refreshed cookie cannot be persisted', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      actorKiloUserId: actor.id,
    });
    let profileRequests = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/profile/self')) {
        if (profileRequests++ === 0) {
          return Response.json({ type: 'reauthentication_required' }, { status: 403 });
        }
        return Response.json({ handle: 'jane', name: 'Jane' });
      }
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      return Response.json({});
    });
    jest.spyOn(db, 'update').mockImplementation((() => {
      throw new Error('db down with password=hunter2');
    }) as unknown as typeof db.update);

    await expect(testStoredSubstackCredential()).resolves.toEqual({
      status: 'error',
      errorCode: 'substack_cookie_persist_failed',
    });
  });

  it('returns credential_changed when the stored credential was replaced concurrently', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      actorKiloUserId: actor.id,
    });
    let profileRequests = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/profile/self')) {
        if (profileRequests++ === 0) {
          return Response.json({ type: 'reauthentication_required' }, { status: 403 });
        }
        return Response.json({ handle: 'jane', name: 'Jane' });
      }
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      return Response.json({});
    });
    jest.spyOn(db, 'update').mockImplementation((() => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    })) as unknown as typeof db.update);

    await expect(testStoredSubstackCredential()).resolves.toEqual({
      status: 'error',
      errorCode: 'substack_credential_changed',
    });
    expect(parseSubstackCredential(await storedMaterial())).toEqual({
      ok: true,
      credential: { cookie: 'connect.sid=old', totpSecret: RFC_SECRET },
    });
  });

  it('removes the stored row after delete', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({ material: '{"sid":"to-delete"}', actorKiloUserId: actor.id });
    await expect(deleteSubstackCredential()).resolves.toEqual({ deleted: true });
    await expect(getSubstackCredentialMeta()).resolves.toEqual({
      configured: false,
      totpConfigured: false,
      updatedAt: null,
      updatedByKiloUserId: null,
    });
  });

  it('defaults the publication to blog.kilo.ai', () => {
    delete process.env.SUBSTACK_PUBLICATION_URL;
    expect(getSubstackPublicationUrl()).toBe('https://blog.kilo.ai');
  });
});
