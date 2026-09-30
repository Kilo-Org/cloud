import { Platform, type TextProps } from 'react-native';

import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { cn } from '@/lib/utils';

// Shared persistent-status/error component (P2-C-15a). Renders the message
// as a `Text` and exposes one announcement channel per platform: a polite
// live region on Android (native announcement on content change) and an
// imperative `announceForA11y` on iOS via `useStatusAnnouncement`. A `null`
// message renders nothing, so the component doubles as its own empty state.

const TONE_CLASS = {
  error: 'text-destructive',
  status: 'text-muted-foreground',
} as const;

type AccessibleStatusProps = {
  /** The status/error text. `null` renders nothing and clears the announcement. */
  message: string | null;
  /** Default text color for the tone; call sites override with `className`. */
  tone?: keyof typeof TONE_CLASS;
  className?: string;
  /**
   * Truncate to this many lines, forwarded to the rendered `Text`. A status
   * that shares a row with other content (the composer's reason line) caps a
   * long line so it cannot grow the layout it sits above.
   */
  numberOfLines?: number;
  /** How truncation marks overflow, forwarded to the rendered `Text`. */
  ellipsizeMode?: TextProps['ellipsizeMode'];
};

export function AccessibleStatus({
  message,
  tone = 'error',
  className,
  numberOfLines,
  ellipsizeMode,
}: Readonly<AccessibleStatusProps>) {
  useStatusAnnouncement(message);
  if (message == null) {
    return null;
  }
  return (
    <Text
      accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
      numberOfLines={numberOfLines}
      ellipsizeMode={ellipsizeMode}
      className={cn(TONE_CLASS[tone], className)}
    >
      {message}
    </Text>
  );
}
