'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';
import {
  OpenAiChatGptCard,
  OpenAiChatGptCardView,
} from '@/components/organizations/byok/OpenAiChatGptCard';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

export default function PersonalBYOKPage() {
  // The flag's release condition matches the `email` person property against the
  // approved domains, so a person outside the list never sees the card.
  const chatGptEnabled = useFeatureFlagEnabled(CHATGPT_ACCESS_FLAG);

  return (
    <PageLayout title="Bring Your Own Key">
      <div className="space-y-4">
        {chatGptEnabled === true ? (
          <OpenAiChatGptCard />
        ) : chatGptEnabled === undefined ? (
          // Hold the card's reserved height until the flags resolve, so the key
          // list does not shift when the card appears.
          <OpenAiChatGptCardView status={undefined} />
        ) : null}
        <BYOKKeysManager />
      </div>
    </PageLayout>
  );
}
