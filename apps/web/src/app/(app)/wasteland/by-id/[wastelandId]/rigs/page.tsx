import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { RigsClient } from './RigsClient';

export default async function RigsPage({ params }: { params: Promise<{ wastelandId: string }> }) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/rigs`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <RigsClient wastelandId={wastelandId} />;
}
