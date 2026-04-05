import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';

export default async function KiloClawSuccessLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    redirect('/users/sign_in?callbackPath=/payments/kiloclaw/success');
  }
  return <>{children}</>;
}
