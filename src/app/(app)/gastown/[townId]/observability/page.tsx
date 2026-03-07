import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
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
  if (!(await isFeatureFlagEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <ObservabilityPageClient townId={townId} />;
}
