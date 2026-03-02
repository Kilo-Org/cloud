import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { BeadsPageClient } from './BeadsPageClient';

export default async function BeadsPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/beads`
  );
  if (!ENABLE_GASTOWN_FEATURE || !user.is_admin) return notFound();
  return <BeadsPageClient townId={townId} />;
}
