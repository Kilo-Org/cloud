import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { TownOverviewPageClient } from './TownOverviewPageClient';

export default async function TownOverviewPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}`);

  if (!ENABLE_GASTOWN_FEATURE || !user.is_admin) {
    return notFound();
  }

  return <TownOverviewPageClient townId={townId} />;
}
