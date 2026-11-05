'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';
import {
  OpenAiChatGptCard,
  OpenAiChatGptCardView,
} from '@/components/organizations/byok/OpenAiChatGptCard';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';
import { CLAUDE_BILLING_FLAG } from '@/lib/auth/claude/access';
import {
  ClaudeBillingCard,
  ClaudeBillingCardView,
} from '@/components/organizations/byok/ClaudeBillingCard';

export default function PersonalBYOKPage() {
  // The flag's release condition matches the `email` person property against the
  // approved domains, so a person outside the list never sees the card.
  const chatGptEnabled = useFeatureFlagEnabled(CHATGPT_ACCESS_FLAG);
  const claudeBillingEnabled = useFeatureFlagEnabled(CLAUDE_BILLING_FLAG);

  return (
    <PageLayout title="Bring Your Own Key">
      <div className="space-y-4">
        {process.env.NODE_ENV === 'development' || claudeBillingEnabled === true ? (
          <ClaudeBillingCard />
        ) : claudeBillingEnabled === undefined ? (
          <ClaudeBillingCardView status={undefined} />
        ) : null}
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
