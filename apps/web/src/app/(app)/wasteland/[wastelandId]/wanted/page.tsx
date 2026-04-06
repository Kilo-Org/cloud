import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { WantedBoardClient } from './WantedBoardClient';

export default async function WantedBoardPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/wanted`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <WantedBoardClient wastelandId={wastelandId} />;
}
