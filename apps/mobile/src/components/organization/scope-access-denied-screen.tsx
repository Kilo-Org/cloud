import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { StateAction } from '@/components/empty-state';
import { DirectionalArrowLeft } from '@/components/ui/directional-icons';
import { RotateCcw } from '@/components/ui/icons';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { type OrganizationScopeAccess } from '@/lib/organization-scope-access';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';

/**
 * The organization scope the reader may not see: access was lost, or the
 * organization was deleted. Both product landings render it instead of their
 * own first-run or empty state, so a lost membership never reads as "nothing is
 * set up yet" and never offers a setup the reader cannot complete.
 *
 * Leaving leads: Back to profile drops the stale selection, exactly like the
 * shared organization boundary's absent-override state, so the reader lands on
 * a scope they can open. Retry only re-resolves the membership, for an owner
 * who restores access while the reader waits. A deleted organization cannot
 * come back, so the not-found state is the shared one with Back alone.
 */
export function ScopeAccessDeniedScreen({
  title,
  subtitle,
  kind,
  onRetry,
  isRetrying = false,
  backFallback,
}: Readonly<{
  /** ScreenHeader's title: the product's name. */
  title: string;
  /** The line under the title: the organization the reader may not see. */
  subtitle?: string;
  /** `'not-found'` for an organization that no longer exists. */
  kind: Exclude<OrganizationScopeAccess, 'granted'>;
  onRetry: () => void;
  isRetrying?: boolean;
  /** Where the header's Back lands when this state has no history to pop. */
  backFallback?: Href;
}>) {
  // Leaving for Profile swaps this denied state's route out, so it goes through
  // the push-then-retire hook: a literal `router.replace` swaps both in one
  // native-stack commit and crashes Android Fabric.
  const { replace } = useStackSafeReplace();
  const { t } = useTranslation();
  const notFound = kind === 'not-found';
  const backToProfile = (
    <StateAction
      label={t('organization.boundary.backToProfile')}
      icon={DirectionalArrowLeft}
      onPress={() => {
        replace(PROFILE_TAB_HREF);
      }}
    />
  );

  return (
    <PlatformErrorScreen
      title={title}
      subtitle={subtitle}
      backFallback={backFallback}
      variant={notFound ? 'not-found' : 'permission'}
      message={t(
        notFound
          ? 'organization.boundary.unavailableDescription'
          : 'organization.boundary.accessDeniedDescription'
      )}
      action={
        notFound ? (
          backToProfile
        ) : (
          <View className="gap-3">
            {/* Leaving is the recovery this surface leads with, so it holds the
                one filled control. Retry only re-resolves the membership, and
                the state slot has one action shape for both. */}
            {backToProfile}
            <StateAction
              label={t('common.retry')}
              icon={RotateCcw}
              loading={isRetrying}
              onPress={onRetry}
            />
          </View>
        )
      }
    />
  );
}
