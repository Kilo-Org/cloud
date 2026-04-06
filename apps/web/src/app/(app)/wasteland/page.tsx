import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { WastelandListPageClient } from './WastelandListPageClient';

export default async function WastelandPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/wasteland');

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <WastelandListPageClient />;
}
