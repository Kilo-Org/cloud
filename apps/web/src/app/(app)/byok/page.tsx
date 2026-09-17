'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';
import { OpenAiChatGptCard } from '@/components/organizations/byok/OpenAiChatGptCard';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

export default function PersonalBYOKPage() {
  // The flag's release condition matches the `email` person property against the
  // approved domains, so a person outside the list never sees the card.
  const chatGptEnabled = useFeatureFlagEnabled(CHATGPT_ACCESS_FLAG);

  return (
    <PageLayout title="Bring Your Own Key">
      <div className="space-y-4">
        {chatGptEnabled === true ? <OpenAiChatGptCard /> : null}
        <BYOKKeysManager />
      </div>
    </PageLayout>
  );
}
