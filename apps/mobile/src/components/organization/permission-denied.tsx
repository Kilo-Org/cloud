import { type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Lock } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';
import { DirectionalArrowLeft } from '@/components/ui/directional-icons';

type PermissionDeniedProps = Readonly<{
  /**
   * The denial's copy, muted under the title. A node when the denial carries
   * more than one reason as its own block (the Bitbucket sheet's role sentence
   * over its lapsed-plan line), the same contract as `EmptyState`.
   */
  description: ReactNode;
  /**
   * Whether the denial draws its own way back. A caller that paints the screen's
   * header above it already owns the back affordance, so the state must not
   * repeat it; a caller showing the denial as the whole surface — no header to
   * leave by — keeps it. Defaults to `true`.
   */
  showBack?: boolean;
  /**
   * The state's way out when the denial has one: a caller passes the action its
   * own state can offer (a retry), and it replaces the back control. Omitted
   * when the caller can offer nothing to press.
   */
  action?: ReactNode;
}>;

/**
 * Shown in place of a privileged form when the signed-in role can't perform
 * the action — e.g. reached by a deep link or stale state rather than
 * through the (role-gated) entry point that would normally hide it.
 */
export function PermissionDenied({ description, action, showBack = true }: PermissionDeniedProps) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <EmptyState
      className="bg-background"
      icon={Lock}
      title={t('common.accessDenied')}
      description={description}
      action={
        action ??
        (showBack ? (
          <StateAction
            label={t('common.back')}
            icon={DirectionalArrowLeft}
            onPress={() => {
              router.back();
            }}
          />
        ) : undefined)
      }
    />
  );
}
