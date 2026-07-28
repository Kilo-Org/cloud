import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { GASTOWN_BILLING_ANNOUNCEMENT_ENABLED } from '@/lib/config.server';
import { TownOverviewPageClient } from './TownOverviewPageClient';

export default async function TownOverviewPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}`);

  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return (
    <TownOverviewPageClient
      townId={townId}
      billingAnnouncementEnabled={GASTOWN_BILLING_ANNOUNCEMENT_ENABLED}
    />
  );
}
