import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { MailPageClient } from './MailPageClient';

export default async function MailPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/mail`
  );
  if (!(await isGastownEnabled(user.id))) return notFound();
  return <MailPageClient townId={townId} />;
}
