import {
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
} from '@kilocode/db/schema-types';
import { user_deletion_requests } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  authPassesDeletionFence,
  assertNoActiveDeletionFence,
} from '@/lib/user/deletion-queue/deletion-identity-fence';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

describe('deletion identity fence', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
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
  });

  it('lets auth continue when the fence lookup throws unexpectedly', async () => {
    await expect(
      authPassesDeletionFence({
        email: 'anyone@example.com',
        executor: {
          select: () => {
            throw new Error('relation "user_deletion_requests" does not exist');
          },
        } as never,
      })
    ).resolves.toBe(true);
  });
});
