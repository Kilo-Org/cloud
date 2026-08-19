import {
  AlertCircle,
  Lock,
  type LucideIcon,
  SearchX,
  ServerCrash,
  WifiOff,
} from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export type QueryErrorVariant = 'neutral' | 'offline' | 'permission' | 'not-found' | 'server';

const VARIANT_META = {
  neutral: {
    icon: AlertCircle,
    title: 'Something went wrong',
    description: 'Please try again.',
  },
  offline: {
    icon: WifiOff,
    title: 'Failed to load',
    description: 'Something went wrong',
  },
  permission: {
    icon: Lock,
    title: 'Access denied',
    description: "You don't have permission to view this.",
  },
  'not-found': {
    icon: SearchX,
    title: 'Not found',
    description: 'This item may have been removed or is no longer available.',
  },
  server: {
    icon: ServerCrash,
    title: 'Could not load',
    description: 'Something went wrong on our end. Please try again.',
  },
} satisfies Record<QueryErrorVariant, { icon: LucideIcon; title: string; description: string }>;

type QueryErrorProps = {
  variant?: QueryErrorVariant;
  title?: string;
  message?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
  placement?: 'center' | 'top';
};

export function QueryError({
  // Default to the generic "unknown" state — asserting 'offline' when we don't
  // actually know the cause is a false signal (a 500 is not a connectivity
  // problem). Callers pass an explicit variant when the cause is known.
  variant = 'neutral',
  title,
  message,
  onRetry,
  isRetrying = false,
  className,
  placement = 'center',
}: Readonly<QueryErrorProps>) {
  const meta = VARIANT_META[variant];
  const titleText = title ?? meta.title;
  const descriptionText = message ?? meta.description;

  return (
    <EmptyState
      icon={meta.icon}
      title={titleText}
      description={
        <AccessibleStatus message={descriptionText} tone="error" className="text-center text-sm" />
      }
      className={className}
      placement={placement}
      iconContainerClassName="rounded-full bg-muted p-4"
      iconSize={32}
      iconStrokeWidth={2}
      titleAccessibilityRole="header"
      action={
        onRetry && (
          <Button
            variant="outline"
            onPress={onRetry}
            loading={isRetrying}
            accessibilityLabel="Retry"
          >
            <Text>Retry</Text>
          </Button>
        )
      }
    />
  );
}
