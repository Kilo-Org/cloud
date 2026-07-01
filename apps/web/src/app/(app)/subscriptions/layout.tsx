import type { ReactNode } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function SubscriptionsLayout({ children }: { children: ReactNode }) {
  await getUserFromAuthOrRedirect();
  return children;
}
