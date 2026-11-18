import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function TopUpSuccessLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
