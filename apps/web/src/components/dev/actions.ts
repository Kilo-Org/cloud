'use server';

import { redirect } from 'next/navigation';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { findUserById, softDeleteUser } from '@/lib/user';
import { getUserFromAuth } from '@/lib/user/server';
import { captureException } from '@sentry/nextjs';

export async function nuke() {
  if (!IS_DEVELOPMENT) {
    throw new Error('Nuke is only available in development');
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse || !user) {
    throw new Error('Unauthorized');
  }

  try {
    const current = await findUserById(user.id);
    if (!current) {
      throw new Error(`User not found: ${user.id}`);
    }

    await softDeleteUser(user.id);
  } catch (error) {
    console.error('Error nuking account:', error);
    captureException(error, {
      tags: { source: 'dev_nuke_account' },
      extra: { kiloUserId: user.id },
      level: 'error',
    });
    throw new Error('Failed to nuke account. Please try again later.');
  }

  redirect('/users/sign_out?callbackUrl=/profile');
}
