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
          {onRetry && <Banner.Button variant="outline" onClick={onRetry}>Retry</Banner.Button>}
          {onDismiss && <Banner.Button variant="ghost" onClick={onDismiss}>Dismiss</Banner.Button>}
        </Banner.Action>
      )}
    </Banner>
  );
}
