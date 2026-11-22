import type * as DrizzleModule from '@kilocode/web-shared/lib/drizzle';
import type { User } from '@kilocode/db/schema';

const mockHeaders = jest.fn<Promise<Headers>, []>();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

const mockGetServerSession = jest.fn();
const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  redirect: (url: string) => mockRedirect(url),
}));

// The browser-session branch reads the user row through `readDb` and the session
// pepper through the primary. `db` stays real, so the primary read and the
// fixtures are the test database. `readDb` delegates to the real client except
// for the user lookup, which returns `mockReplicaUser` while a test sets it.
let mockReplicaUser: User | null = null;

jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const actual = jest.requireActual<typeof DrizzleModule>('@kilocode/web-shared/lib/drizzle');
  const realUsersQuery = actual.db.query.kilocode_users;
  const replicaUsersQuery = new Proxy(realUsersQuery, {
    get(target, property) {
      if (property === 'findFirst') {
        return (args: Parameters<typeof realUsersQuery.findFirst>[0]) =>
          Promise.resolve(mockReplicaUser ?? realUsersQuery.findFirst(args));
      }
      return Reflect.get(target, property, target);
    },
  });
  const replicaQuery = new Proxy(actual.db.query, {
    get(target, property) {
      if (property === 'kilocode_users') return replicaUsersQuery;
      return Reflect.get(target, property, target);
    },
  });
  const readDb = new Proxy(actual.db, {
    get(target, property) {
      if (property === 'query') return replicaQuery;
      return Reflect.get(target, property, target);
    },
  });
  return { ...actual, readDb };
});

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getUserFromAuth, getUserFromSessionForCredentialIssuanceOrRedirect } from './server';

describe('web session revocation read from the primary', () => {
  const insertedUserIds: string[] = [];

  async function insertSessionUser(pepper: string): Promise<User> {
    const user = await insertTestUser({ web_session_pepper: pepper });
    insertedUserIds.push(user.id);
    return user;
  }

  beforeEach(() => {
    mockHeaders.mockReset();
    mockGetServerSession.mockReset();
    mockRedirect.mockClear();
    mockReplicaUser = null;
  });

  afterEach(async () => {
    mockReplicaUser = null;
    if (insertedUserIds.length > 0) {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, insertedUserIds));
      insertedUserIds.length = 0;
    }
  });

  test('admits a session the primary still carries', async () => {
    const user = await insertSessionUser('primary-pepper');
    mockReplicaUser = { ...user, web_session_pepper: 'primary-pepper' };
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'primary-pepper',
    });

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.authFailedResponse).toBeNull();
    expect(result.user?.id).toBe(user.id);
  });

  test('refuses a session the primary revoked but a lagging replica still carries', async () => {
    const user = await insertSessionUser('primary-pepper');
    mockReplicaUser = { ...user, web_session_pepper: 'replica-pepper' };
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'replica-pepper',
    });

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('redirects a revoked session to sign-in instead of a user', async () => {
    const user = await insertSessionUser('primary-pepper');
    mockReplicaUser = { ...user, web_session_pepper: 'replica-pepper' };
    mockHeaders.mockResolvedValue(new Headers({ 'x-pathname': '/profile' }));
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'replica-pepper',
    });

    await expect(getUserFromSessionForCredentialIssuanceOrRedirect()).rejects.toThrow(
      'NEXT_REDIRECT:/users/sign_in?callbackPath=%2Fprofile'
    );
    expect(mockRedirect).toHaveBeenCalledWith('/users/sign_in?callbackPath=%2Fprofile');
  });
});
