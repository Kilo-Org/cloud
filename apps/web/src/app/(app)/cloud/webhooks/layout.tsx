import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function CloudWebhooksLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
