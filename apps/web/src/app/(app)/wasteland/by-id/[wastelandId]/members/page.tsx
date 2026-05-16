import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { MembersClient } from './MembersClient';

export default async function MembersPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/members`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <MembersClient wastelandId={wastelandId} />;
}
