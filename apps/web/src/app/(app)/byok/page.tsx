'use client';

import { useState } from 'react';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';
import {
  OpenAiChatGptCard,
  OpenAiChatGptCardView,
} from '@/components/organizations/byok/OpenAiChatGptCard';
import { CHATGPT_ACCESS_FLAG } from '@kilocode/app-shared/feature-flags';
import { ClaudeBillingCard } from '@/components/organizations/byok/ClaudeBillingCard';
import type { SignInMethodChallenge } from '@/components/profile/SignInMethodCodeDialog';

export default function PersonalBYOKPage() {
  // The flag's release condition matches the `email` person property against the
  // approved domains, so a person outside the list never sees the card.
  const chatGptEnabled = useFeatureFlagEnabled(CHATGPT_ACCESS_FLAG);
  const [codeChallenge, setCodeChallenge] = useState<SignInMethodChallenge | null>(null);

  return (
    <PageLayout title="Bring Your Own Key">
      <div className="space-y-4">
        {chatGptEnabled === true ? (
          <OpenAiChatGptCard
            codeChallenge={codeChallenge}
            onCodeChallengeChange={setCodeChallenge}
          />
        ) : chatGptEnabled === undefined ? (
          // Hold the card's reserved height until the flags resolve, so the key
          // list does not shift when the card appears.
          <OpenAiChatGptCardView status={undefined} />
        ) : null}
        <ClaudeBillingCard />
        <BYOKKeysManager />
      </div>
    </PageLayout>
  );
}
