import type { ReactNode } from 'react';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';

export default async function SubscriptionsLayout({ children }: { children: ReactNode }) {
  await getUserFromAuthOrRedirect();
  return children;
}
