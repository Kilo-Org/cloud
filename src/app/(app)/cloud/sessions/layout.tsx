import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function CloudSessionsLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
