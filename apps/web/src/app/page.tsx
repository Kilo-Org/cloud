import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user/server';
import { browserLandingPath } from '@/lib/app-link-safe-redirect';
import { redirect } from 'next/navigation';

export default async function Home() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    redirect('/users/sign_in');
  }
  redirect(browserLandingPath(await getProfileRedirectPath(user)));
}
