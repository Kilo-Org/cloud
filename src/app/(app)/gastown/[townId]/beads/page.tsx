import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { BeadsPageClient } from './BeadsPageClient';

export default async function BeadsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/beads`
  );
  if (!(await isGastownEnabled(user.id))) return notFound();
  return <BeadsPageClient townId={townId} />;
}
