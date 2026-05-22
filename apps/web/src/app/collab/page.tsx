import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrefetchedOrganizations } from '@/app/(app)/components/PrefetchedOrganizations';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { BotWizard } from './_components/BotWizard';

export const metadata: Metadata = {
  title: 'Set up your Kilo bot',
  description: 'Connect Kilo to the chat, code, and issue tools your team already uses.',
};

export default async function CollabSetupPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/collab');
  if (user.is_admin !== true) notFound();

  return (
    <KiloCardLayout bare className="max-w-2xl" contentClassName="">
      <PrefetchedOrganizations>
        <BotWizard />
      </PrefetchedOrganizations>
    </KiloCardLayout>
  );
}
