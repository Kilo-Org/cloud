import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';

export default async function Home() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    redirect('/users/sign_in');
  }
  redirect(await getProfileRedirectPath(user));
}
