import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';
import { isWorkerAuthCookieExpiring } from '@/lib/kiloclaw/worker-auth-cookie';
import { CookieRefresher } from './cookie-refresher';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) redirect('/sign-in');

  // Access gate: @kilocode.ai only
  if (!user.google_user_email?.endsWith('@kilocode.ai')) {
    redirect('/');
  }

  const needsCookieRefresh = await isWorkerAuthCookieExpiring();

  return (
    <>
      {needsCookieRefresh && <CookieRefresher />}
      {children}
    </>
  );
}
