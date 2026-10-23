import { type ReactNode } from 'react';
import { View } from 'react-native';

import { QueryError, type QueryErrorVariant } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';

/**
 * Full-screen "load failed" state: a ScreenHeader over a centered QueryError,
 * padded above the tab bar. Shared by code-reviewer's platform overview
 * screens and security-agent's settings/dashboard screens — both render
 * exactly this shape when their top-level query errors out with no cached
 * data to fall back on.
 */
export function PlatformErrorScreen({
  title,
  eyebrow,
  errorTitle,
  message,
  variant = 'server',
  onRetry,
  isRetrying = false,
  action,
}: Readonly<{
  /** ScreenHeader's title, e.g. the screen/feature name. */
  title: string;
  eyebrow?: string;
  /** QueryError's own title override — independent of the ScreenHeader title above. */
  errorTitle?: string;
  message?: string;
  variant?: QueryErrorVariant;
  /** Omit to render a non-retriable state (e.g. permission/not-found errors). */
  onRetry?: () => void;
  isRetrying?: boolean;
  /** Replaces the built-in retry button with a caller-composed recovery row. */
  action?: ReactNode;
}>) {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} eyebrow={eyebrow} />
      <QueryError
        variant={variant}
        title={errorTitle}
        message={message}
        onRetry={onRetry}
        isRetrying={isRetrying}
        action={action}
      />
    </View>
  );
}
