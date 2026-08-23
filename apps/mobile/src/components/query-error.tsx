import {
  AlertCircle,
  Lock,
  type LucideIcon,
  SearchX,
  ServerCrash,
  WifiOff,
} from '@/components/ui/icons';
import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export type QueryErrorVariant = 'neutral' | 'offline' | 'permission' | 'not-found' | 'server';

const VARIANT_ICONS = {
  neutral: AlertCircle,
  offline: WifiOff,
  permission: Lock,
  'not-found': SearchX,
  server: ServerCrash,
} satisfies Record<QueryErrorVariant, LucideIcon>;

const VARIANT_META_KEYS = {
  neutral: { title: 'queryError.neutralTitle', description: 'queryError.neutralDescription' },
  offline: { title: 'queryError.offlineTitle', description: 'queryError.offlineDescription' },
  permission: {
    title: 'queryError.permissionTitle',
    description: 'queryError.permissionDescription',
  },
  'not-found': {
    title: 'queryError.notFoundTitle',
    description: 'queryError.notFoundDescription',
  },
  server: { title: 'queryError.serverTitle', description: 'queryError.serverDescription' },
} as const;

function variantMeta(t: TFunction, variant: QueryErrorVariant) {
  const meta = VARIANT_META_KEYS[variant];
  return { title: t(meta.title), description: t(meta.description) };
}

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
  const { t } = useTranslation();
  const meta = variantMeta(t, variant);
  const titleText = title ?? meta.title;
  const descriptionText = message ?? meta.description;

  return (
    <EmptyState
      icon={VARIANT_ICONS[variant]}
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
            accessibilityLabel={t('common.retry')}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        )
      }
    />
  );
}
