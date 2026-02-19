import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserFromAuthOrRedirect();

  const isKiloClawEnabled = await isReleaseToggleEnabled('kiloclaw', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isKiloClawEnabled && !isDevelopment) {
    redirect('/');
  }

  return <>{children}</>;
}
