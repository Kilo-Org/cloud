import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { AgentsPageClient } from './AgentsPageClient';

export default async function AgentsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/agents`
  );
  if (!(await isReleaseToggleEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <AgentsPageClient townId={townId} />;
}
