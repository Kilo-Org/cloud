import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { BlockedNotification } from '@/components/auth/BlockedNotification';

export default async function AccountBlockedPage() {
  const user = (await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }))
    ?.user;
  if (!user) {
    redirect('/users/sign_in');
  } else if (!isBlockedAccount(user)) {
    redirect('/profile');
  }

  return <BlockedNotification />;
}
