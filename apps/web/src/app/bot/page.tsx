import type { Metadata } from 'next';
import { PrefetchedOrganizations } from '@/app/(app)/components/PrefetchedOrganizations';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { BotWizard } from './_components/BotWizard';

export const metadata: Metadata = {
  title: 'Set up your Kilo bot',
  description: 'Connect Kilo to the chat, code, and issue tools your team already uses.',
};

export default function BotSetupPage() {
  return (
    <KiloCardLayout bare className="max-w-2xl" contentClassName="">
      <PrefetchedOrganizations>
        <BotWizard />
      </PrefetchedOrganizations>
    </KiloCardLayout>
  );
}
