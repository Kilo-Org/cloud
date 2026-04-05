import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';
import { BlockedNotification } from '@/components/auth/BlockedNotification';

export default async function AccountBlockedPage() {
  const user = (await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }))
    ?.user;
  if (!user) {
    redirect('/users/sign_in');
  } else if (!user.blocked_reason) {
    redirect('/profile');
  }

  return <BlockedNotification />;
}
