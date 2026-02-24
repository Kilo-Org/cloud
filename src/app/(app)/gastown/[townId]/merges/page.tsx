import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { MergesPageClient } from './MergesPageClient';

export default async function MergesPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}/merges`);
  if (!ENABLE_GASTOWN_FEATURE) return notFound();
  return <MergesPageClient townId={townId} />;
}
