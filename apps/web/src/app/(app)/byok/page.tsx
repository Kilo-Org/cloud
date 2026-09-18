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
        {chatGptEnabled !== false ? (
          <section aria-labelledby="connected-accounts" className="space-y-4">
            <h2 id="connected-accounts" className="type-heading">
              Connected Accounts
            </h2>
            {chatGptEnabled === true ? (
              <OpenAiChatGptCard />
            ) : (
              // Reserve the card's height until the feature flag resolves.
              <OpenAiChatGptCardView status={undefined} />
            )}
          </section>
        ) : null}
        <BYOKKeysManager />
      </div>
    </PageLayout>
  );
}
