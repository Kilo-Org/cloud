import type { ReactNode } from 'react';
import { KiloPassIcon } from '@/components/icons/KiloPassIcon';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';

export function OrgKiloPassGroupShell({
  children,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  unframed = false,
}: {
  children: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  unframed?: boolean;
}) {
  return (
    <SubscriptionGroup
      title="Kilo Pass for Organizations"
      description="Shared monthly Credits for each paid seat."
      headerIcon={<KiloPassIcon className="size-5" />}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={onRetry}
      unframed={unframed}
    >
      {children}
    </SubscriptionGroup>
  );
}
