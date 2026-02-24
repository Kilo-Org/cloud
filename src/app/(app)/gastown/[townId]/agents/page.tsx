import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { AgentsPageClient } from './AgentsPageClient';

export default async function AgentsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}/agents`);
  if (!ENABLE_GASTOWN_FEATURE) return notFound();
  return <AgentsPageClient townId={townId} />;
}
