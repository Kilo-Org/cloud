import {
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
} from '@kilocode/db/schema-types';
import { user_deletion_requests } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import {
  authPassesDeletionFence,
  assertNoActiveDeletionFence,
} from '@/lib/user/deletion-queue/deletion-identity-fence';
import { DeletionHmacError, hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/deletion-hmac', () => {
  const actual = jest.requireActual('@/lib/user/deletion-queue/deletion-hmac');
  return { ...actual, hmacDeletionEmail: jest.fn(actual.hmacDeletionEmail) };
});

const hmacDeletionEmailMock = jest.mocked(hmacDeletionEmail);
const captureExceptionMock = jest.mocked(captureException);

const selectChainWithNoRows = () => ({
  from: () => ({
    where: () => ({
      limit: async () => [],
    }),
  }),
});

const executorThrowingLookup = {
  select: () => {
    throw new Error('relation "user_deletion_requests" does not exist');
  },
};

describe('deletion identity fence', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    hmacDeletionEmailMock.mockClear();
    captureExceptionMock.mockClear();
  });

  it('blocks auth when an active deletion covers the email', async () => {
    const user = await insertTestUser({ google_user_email: 'fenced@example.com' });
    await db.insert(user_deletion_requests).values({
      user_id: user.id,
      status: UserDeletionRequestStatus.InProgress,
      target_email: user.google_user_email,
      target_email_hmac: hmacDeletionEmail(user.google_user_email.toLowerCase()),
      cloud_subject_resolution: UserDeletionCloudSubjectResolution.CurrentUser,
    });

    await expect(assertNoActiveDeletionFence({ email: user.google_user_email })).rejects.toThrow(
      /active user deletion/
    );
    await expect(authPassesDeletionFence({ email: user.google_user_email })).resolves.toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('blocks auth when an active deletion covers the user id', async () => {
    const user = await insertTestUser({ google_user_email: 'fenced-by-id@example.com' });
    await db.insert(user_deletion_requests).values({
      user_id: user.id,
      status: UserDeletionRequestStatus.InProgress,
      target_email: 'someone-else@example.com',
      target_email_hmac: hmacDeletionEmail('someone-else@example.com'),
      cloud_subject_resolution: UserDeletionCloudSubjectResolution.CurrentUser,
    });

    await expect(
      authPassesDeletionFence({ email: 'unrelated@example.com', userId: user.id })
    ).resolves.toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('blocks auth when the fence lookup throws unexpectedly', async () => {
    await expect(
      authPassesDeletionFence({
        email: 'anyone@example.com',
        executor: executorThrowingLookup as never,
      })
    ).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'deletion-identity-fence' },
    });
  });

  it('blocks auth when the user id lookup throws after the email lookup found nothing', async () => {
    const select = jest
      .fn()
      .mockImplementationOnce(selectChainWithNoRows)
      .mockImplementationOnce(() => {
        throw new Error('connection terminated unexpectedly');
      });

    await expect(
      authPassesDeletionFence({
        email: 'anyone@example.com',
        userId: 'user-id',
        executor: { select } as never,
      })
    ).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'deletion-identity-fence' },
    });
  });

  it('blocks auth when the deletion email hmac cannot be computed', async () => {
    hmacDeletionEmailMock.mockImplementationOnce(() => {
      throw new DeletionHmacError('USER_DELETION_AUDIT_HMAC_KEY is not configured');
    });

    await expect(authPassesDeletionFence({ email: 'anyone@example.com' })).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(DeletionHmacError), {
      tags: { source: 'deletion-identity-fence' },
    });
  });

  it('lets auth continue when the fence lookup completes without an active deletion', async () => {
    await expect(
      assertNoActiveDeletionFence({ email: 'nobody@example.com' })
    ).resolves.toBeUndefined();
    await expect(authPassesDeletionFence({ email: 'nobody@example.com' })).resolves.toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
