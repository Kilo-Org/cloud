import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { TownListPageClient } from './TownListPageClient';

export default async function GastownPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <TownListPageClient />;
}
