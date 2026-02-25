import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
