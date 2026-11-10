import { useRouter } from 'expo-router';
import { Lock } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

type PermissionDeniedProps = Readonly<{
  description: string;
}>;

/**
 * Shown in place of a privileged form when the signed-in role can't perform
 * the action — e.g. reached by a deep link or stale state rather than
 * through the (role-gated) entry point that would normally hide it.
 */
export function PermissionDenied({ description }: PermissionDeniedProps) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <EmptyState
      className="bg-background"
      icon={Lock}
      title={t('common.accessDenied')}
      description={description}
      action={
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            router.back();
          }}
        >
          <Text>{t('common.back')}</Text>
        </Button>
      }
    />
  );
}
