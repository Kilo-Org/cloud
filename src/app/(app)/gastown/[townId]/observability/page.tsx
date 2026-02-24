import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { ObservabilityPageClient } from './ObservabilityPageClient';

export default async function ObservabilityPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}/observability`);
  if (!ENABLE_GASTOWN_FEATURE) return notFound();
  return <ObservabilityPageClient townId={townId} />;
}
