import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function CloudWebhooksLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
