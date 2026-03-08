import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { AgentsPageClient } from './AgentsPageClient';

export default async function AgentsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/agents`
  );
  if (!(await isGastownEnabled(user.id))) return notFound();
  return <AgentsPageClient townId={townId} />;
}
