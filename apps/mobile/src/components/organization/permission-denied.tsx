import { useRouter } from 'expo-router';
import { ArrowLeft, Lock } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';

type PermissionDeniedProps = Readonly<{
  description: string;
  /**
   * Whether the denial draws its own way back. A caller that paints the screen's
   * header above it already owns the back affordance, so the state must not
   * repeat it; a caller showing the denial as the whole surface — no header to
   * leave by — keeps it. Defaults to `true`.
   */
  showBack?: boolean;
}>;

/**
 * Shown in place of a privileged form when the signed-in role can't perform
 * the action — e.g. reached by a deep link or stale state rather than
 * through the (role-gated) entry point that would normally hide it.
 */
export function PermissionDenied({ description, showBack = true }: PermissionDeniedProps) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <EmptyState
      className="bg-background"
      icon={Lock}
      title={t('common.accessDenied')}
      description={description}
      action={
        showBack ? (
          <StateAction
            label={t('common.back')}
            icon={ArrowLeft}
            onPress={() => {
              router.back();
            }}
          />
        ) : undefined
      }
    />
  );
}
