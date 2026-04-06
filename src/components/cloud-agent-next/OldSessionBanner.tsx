'use client';

import { Info } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';

type OldSessionBannerProps = {
  onStartNewSession: () => void;
};

export function OldSessionBanner({ onStartNewSession }: OldSessionBannerProps) {
  return (
    <Banner color="amber" role="alert" className="mb-4">
      <Banner.Icon>
        <Info />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Legacy Session</Banner.Title>
        <Banner.Description>
          This is a legacy session displayed in read-only mode. You can start a new session to
          continue working.
        </Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={onStartNewSession}>Start New Session</Banner.Button>
      </Banner.Action>
    </Banner>
  );
}
