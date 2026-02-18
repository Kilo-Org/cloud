import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { TownOverviewPageClient } from './TownOverviewPageClient';

export default async function TownOverviewPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!ENABLE_GASTOWN_FEATURE) {
    return notFound();
  }

  const { townId } = await params;

  return <TownOverviewPageClient townId={townId} />;
}
