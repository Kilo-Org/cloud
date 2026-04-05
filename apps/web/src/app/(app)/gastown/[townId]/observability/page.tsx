import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { ObservabilityPageClient } from './ObservabilityPageClient';

export default async function ObservabilityPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/observability`
  );
  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) return notFound();
  return <ObservabilityPageClient townId={townId} />;
}
