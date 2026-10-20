const mockHeaders = jest.fn<Promise<Headers>, []>();
const mockGetServerSession = jest.fn();

const mockPreviousUser: { user: User | undefined } = { user: undefined };
const mockPreviousMembershipRole: { role: string | null } = { role: null };

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/drizzle');
  return {
    ...actual,
    readDb: {
      query: {
        kilocode_users: {
          findFirst: async () => mockPreviousUser.user,
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () =>
              mockPreviousMembershipRole.role === null
                ? []
                : [{ role: mockPreviousMembershipRole.role }],
          }),
        }),
      }),
    },
  };
});

import { beforeEach, describe, expect, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getUserFromAuth } from './server';

beforeEach(() => {
  mockHeaders.mockReset();
  mockGetServerSession.mockReset();
  mockPreviousUser.user = undefined;
  mockPreviousMembershipRole.role = null;
});

describe('user access checks', () => {
  test('rejects a token that does not match the account pepper', async () => {
    const user = await insertTestUser({ api_token_pepper: 'pepper-a' });
    const token = generateApiToken(user);
    mockPreviousUser.user = user;
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: 'pepper-b' })
      .where(eq(kilocode_users.id, user.id));
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('rejects an account that is blocked', async () => {
    const user = await insertTestUser({ api_token_pepper: 'block-check-pepper' });
    const token = generateApiToken(user);
    mockPreviousUser.user = user;
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'account review' })
      .where(eq(kilocode_users.id, user.id));
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(403);
  });

  test('rejects an admin-only request for an account without the admin flag', async () => {
    const user = await insertTestUser({
      is_admin: true,
      api_token_pepper: 'admin-flag-pepper',
    });
    const token = generateApiToken(user);
    mockPreviousUser.user = user;
    await db.update(kilocode_users).set({ is_admin: false }).where(eq(kilocode_users.id, user.id));
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: true });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(403);
  });

  test('rejects an organization request without an active membership', async () => {
    const user = await insertTestUser({ api_token_pepper: 'membership-pepper' });
    const organization = await createTestOrganization(
      `Membership Organization ${crypto.randomUUID()}`,
      user.id,
      0
    );
    const token = generateApiToken(user);
    mockPreviousUser.user = user;
    mockPreviousMembershipRole.role = 'owner';
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organization.id),
          eq(organization_memberships.kilo_user_id, user.id)
        )
      );
    mockHeaders.mockResolvedValue(
      new Headers({
        Authorization: `Bearer ${token}`,
        [ORGANIZATION_ID_HEADER]: organization.id,
      })
    );

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(403);
  });

  test('rejects a web session that does not match the account pepper', async () => {
    const user = await insertTestUser({ web_session_pepper: 'session-a' });
    mockPreviousUser.user = user;
    await db
      .update(kilocode_users)
      .set({ web_session_pepper: 'session-b' })
      .where(eq(kilocode_users.id, user.id));
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'session-a',
      isNewUser: false,
    });

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
  });
});
