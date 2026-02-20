import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function BYOKLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
