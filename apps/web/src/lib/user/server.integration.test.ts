const mockHeaders = jest.fn<Promise<Headers>, []>();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

import { beforeEach, describe, test, expect } from '@jest/globals';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { generateApiToken } from '@/lib/tokens';
import { eq } from 'drizzle-orm';

beforeEach(() => {
  mockHeaders.mockReset();
});

describe('getUserFromAuth', () => {
  test('an API token minted before a platform-admin grant cannot reach admin-only paths afterward', async () => {
    // Regression: granting platform admin rotates api_token_pepper, so a
    // bearer token issued while the user was non-admin must stop working
    // rather than silently becoming admin-capable.
    const grantingAdmin = await insertTestUser({
      google_user_email: `granting-admin-${crypto.randomUUID()}@kilocode.ai`,
      hosted_domain: 'kilocode.ai',
      is_admin: true,
      is_super_admin: true,
    });
    const target = await insertTestUser({
      google_user_email: `grant-target-${crypto.randomUUID()}@kilocode.ai`,
      hosted_domain: 'kilocode.ai',
      is_admin: false,
      api_token_pepper: 'pre-grant-pepper',
    });

    const preGrantToken = generateApiToken(target);
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${preGrantToken}` }));

    // Before the grant the token is valid but non-admin: an admin-only check fails.
    const beforeGrant = await getUserFromAuth({ adminOnly: true });
    expect(beforeGrant.authFailedResponse).not.toBeNull();

    const caller = await createCallerForUser(grantingAdmin.id);
    await caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true });

    const rotated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, target.id),
    });
    expect(rotated?.is_admin).toBe(true);
    expect(rotated?.api_token_pepper).not.toBe('pre-grant-pepper');

    // The pre-grant token now carries a stale pepper and must be rejected —
    // it must NOT be silently upgraded to admin-capable.
    const afterGrant = await getUserFromAuth({ adminOnly: true });
    expect(afterGrant.authFailedResponse).not.toBeNull();
    expect(afterGrant.user).toBeNull();
  });
});
