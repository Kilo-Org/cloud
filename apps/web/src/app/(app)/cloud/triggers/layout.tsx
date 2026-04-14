import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function CloudTriggersLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
