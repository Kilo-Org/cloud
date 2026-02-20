import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { TownListPageClient } from './TownListPageClient';

export default async function GastownPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!ENABLE_GASTOWN_FEATURE) {
    return notFound();
  }

  return <TownListPageClient />;
}
