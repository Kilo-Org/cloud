import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { MailPageClient } from './MailPageClient';

export default async function MailPage({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/mail`
  );
  if (!(await isReleaseToggleEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <MailPageClient townId={townId} />;
}
