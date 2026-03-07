import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { MergesPageClient } from './MergesPageClient';

export default async function MergesPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/merges`
  );
  if (!(await isReleaseToggleEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <MergesPageClient townId={townId} />;
}
