import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { ClaimsClient } from './ClaimsClient';

export default async function ClaimsPage({ params }: { params: Promise<{ wastelandId: string }> }) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/claims`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <ClaimsClient wastelandId={wastelandId} />;
}
