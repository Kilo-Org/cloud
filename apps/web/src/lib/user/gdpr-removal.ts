import { findUserById } from '@/lib/user';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';

export type GdprRemovalActor = {
  id: string;
  email: string;
  name?: string | null;
};

export async function performGdprRemoval(
  userId: string,
  options: {
    destroyReason: 'admin_request';
    actor: GdprRemovalActor;
  }
): Promise<{ warnings: string[] }> {
  const user = await findUserById(userId);
  if (!user) {
    return { warnings: [] };
  }

  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: options.actor.id, email: options.actor.email },
    targets: [
      {
        email: user.google_user_email,
        trustedUserId: userId,
        allowSelf: true,
      },
    ],
  });

  if (!result) {
    throw new Error('User deletion could not be queued');
  }
  if (result.status === 'refused' || result.status === 'invalid') {
    throw new Error(`User deletion could not be queued (${result.code})`);
  }

  return { warnings: [] };
}
