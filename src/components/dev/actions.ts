'use server';

import { redirect } from 'next/navigation';
import { findUserById, softDeleteUser } from '@/lib/user';
import { deleteStripeCustomer } from '@/lib/stripe-client';
import { captureException } from '@sentry/nextjs';

export async function nuke(kiloUserId: string) {
  try {
    const user = await findUserById(kiloUserId);
    if (!user) {
      throw new Error(`User not found: ${kiloUserId}`);
    }

    await softDeleteUser(kiloUserId);
    await deleteStripeCustomer(user.stripe_customer_id);
  } catch (error) {
    console.error('Error nuking account:', error);
    captureException(error, {
      tags: { source: 'dev_nuke_account' },
      extra: { kiloUserId },
      level: 'error',
    });
    throw new Error('Failed to nuke account. Please try again later.');
  }

  redirect('/api/auth/signout?callbackUrl=/profile');
}
