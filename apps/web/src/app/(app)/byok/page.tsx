'use client';

import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';
import { OpenAiChatGptCard } from '@/components/organizations/byok/OpenAiChatGptCard';

export default function PersonalBYOKPage() {
  return (
    <PageLayout title="Bring Your Own Key">
      <div className="space-y-4">
        <OpenAiChatGptCard />
        <BYOKKeysManager />
      </div>
    </PageLayout>
  );
}
