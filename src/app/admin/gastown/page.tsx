import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';

export default async function GastownIndexPage() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  // Gastown data is scoped to a user — navigate to a user first.
  redirect('/admin/users');
}
