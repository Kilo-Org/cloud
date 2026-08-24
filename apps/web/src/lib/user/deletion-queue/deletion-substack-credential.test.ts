import { eq } from 'drizzle-orm';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import { UserDeletionProviderScope } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  cookieFromCredential,
  deleteSubstackCredential,
  getSubstackCredentialMeta,
  getSubstackPublicationUrl,
  replaceSubstackCredential,
  testSubstackCredentialMaterial,
} from '@/lib/user/deletion-queue/deletion-substack-credential';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('cookieFromCredential', () => {
  it('builds a sid cookie from JSON sid material', () => {
    expect(cookieFromCredential('{"sid":"abc123"}')).toBe('connect.sid=abc123');
  });

  it('returns a raw cookie string unchanged', () => {
    expect(cookieFromCredential('connect.sid=raw-cookie')).toBe('connect.sid=raw-cookie');
  });

  it('uses connect.sid for a bare session value', () => {
    expect(cookieFromCredential('bare-session-value')).toBe('connect.sid=bare-session-value');
  });

  it('returns null for empty material', () => {
    expect(cookieFromCredential('')).toBeNull();
    expect(cookieFromCredential('   ')).toBeNull();
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

  it('returns healthy handle and name without the Substack email', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { handle: 'jane', name: 'Jane Doe', email: 'secret@example.com' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await testSubstackCredentialMaterial('connect.sid=abc123');

    expect(result).toEqual({ status: 'healthy', handle: 'jane', name: 'Jane Doe' });
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
    expect(fetchSpy).toHaveBeenCalledWith(`${publication}/api/v1/user/profile/self`, {
      headers: { Cookie: 'connect.sid=abc123', Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('returns expired on 401', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    await expect(testSubstackCredentialMaterial('connect.sid=expired')).resolves.toEqual({
      status: 'expired',
    });
  });

  it('retries https://substack.com after a publication 404', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ handle: 'fallback', name: 'Fallback' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await expect(testSubstackCredentialMaterial('sid-only')).resolves.toEqual({
      status: 'healthy',
      handle: 'fallback',
      name: 'Fallback',
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      `${publication}/api/v1/user/profile/self`,
      expect.objectContaining({
        headers: { Cookie: 'connect.sid=sid-only', Accept: 'application/json' },
      })
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://substack.com/api/v1/user/profile/self',
      expect.objectContaining({
        headers: { Cookie: 'connect.sid=sid-only', Accept: 'application/json' },
      })
    );
  });

  it('uses the blog.kilo.ai publication when no override is configured', async () => {
    delete process.env.SUBSTACK_PUBLICATION_URL;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ handle: 'default-publication', name: 'Default Publication' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(testSubstackCredentialMaterial('connect.sid=abc123')).resolves.toEqual({
      status: 'healthy',
      handle: 'default-publication',
      name: 'Default Publication',
    });
    expect(getSubstackPublicationUrl()).toBe('https://blog.kilo.ai');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://blog.kilo.ai/api/v1/user/profile/self',
      expect.objectContaining({
        headers: { Cookie: 'connect.sid=abc123', Accept: 'application/json' },
      })
    );
  });
});

describe('deleteSubstackCredential', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('removes the stored substack row after replace', async () => {
    const actor = await insertTestUser({ is_admin: true });
    await replaceSubstackCredential({
      material: '{"sid":"to-delete"}',
      actorKiloUserId: actor.id,
    });
    const before = await getSubstackCredentialMeta();
    expect(before).toMatchObject({
      configured: true,
      updatedByKiloUserId: actor.id,
    });
    expect(before.updatedAt).toEqual(expect.any(String));

    await expect(deleteSubstackCredential()).resolves.toEqual({ deleted: true });
    await expect(getSubstackCredentialMeta()).resolves.toEqual({
      configured: false,
      updatedAt: null,
      updatedByKiloUserId: null,
    });
    const remaining = await db
      .select()
      .from(user_deletion_provider_credentials)
      .where(
        eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
      );
    expect(remaining).toHaveLength(0);
  });
});
