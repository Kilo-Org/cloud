import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { BeadsPageClient } from './BeadsPageClient';

export default async function BeadsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/beads`
  );
  if (!(await isFeatureFlagEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <BeadsPageClient townId={townId} />;
}
