'use client';

import { AlertCircle } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';

type ErrorBannerProps = {
  title?: string;
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function ErrorBanner({ title = 'Error', message, onRetry, onDismiss }: ErrorBannerProps) {
  return (
    <Banner color="red">
      <Banner.Icon>
        <AlertCircle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>{title}</Banner.Title>
        <Banner.Description>{message}</Banner.Description>
      </Banner.Content>
      {(onRetry ?? onDismiss) && (
        <Banner.Action>
          {onRetry && <Banner.Button onClick={onRetry}>Retry</Banner.Button>}
          {onDismiss && <Banner.Button onClick={onDismiss}>Dismiss</Banner.Button>}
        </Banner.Action>
      )}
      {onDismiss && <Banner.Dismiss onDismiss={onDismiss} />}
    </Banner>
  );
}
