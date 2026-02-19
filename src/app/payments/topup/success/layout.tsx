import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function TopUpSuccessLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
