import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { TownListPageClient } from './TownListPageClient';

export default async function GastownPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!ENABLE_GASTOWN_FEATURE || !user.is_admin) {
    return notFound();
  }

  return <TownListPageClient />;
}
