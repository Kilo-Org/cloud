import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound, redirect } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';

export default async function WastelandDashboardPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  redirect(`/wasteland/${wastelandId}/wanted`);
}
