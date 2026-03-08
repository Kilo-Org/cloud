import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { MergesPageClient } from './MergesPageClient';

export default async function MergesPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/merges`
  );
  if (!(await isGastownEnabled(user.id))) return notFound();
  return <MergesPageClient townId={townId} />;
}
