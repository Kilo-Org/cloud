import { useRouter } from 'expo-router';
import { ArrowLeft, Lock } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';

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
        <StateAction
          label={t('common.back')}
          icon={ArrowLeft}
          onPress={() => {
            router.back();
          }}
        />
      }
    />
  );
}
