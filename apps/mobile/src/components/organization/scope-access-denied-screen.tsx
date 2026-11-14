import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type OrganizationScopeAccess } from '@/lib/organization-scope-access';

const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

/**
 * The organization scope the reader may not see: access was lost, or the
 * organization was deleted. Both product landings render it instead of their
 * own first-run or empty state, so a lost membership never reads as "nothing is
 * set up yet" and never offers a setup the reader cannot complete.
 *
 * Leaving leads: Back to profile drops the stale selection, exactly like the
 * shared organization boundary's absent-override state, so the reader lands on
 * a scope they can open. Retry only re-resolves the membership, for an owner
 * who restores access while the reader waits.
 */
export function ScopeAccessDeniedScreen({
  title,
  eyebrow,
  kind,
  onRetry,
  isRetrying = false,
  backFallback,
}: Readonly<{
  /** ScreenHeader's title: the product name, or the organization's name. */
  title: string;
  eyebrow?: string;
  /** `'not-found'` for an organization that no longer exists. */
  kind: Exclude<OrganizationScopeAccess, 'granted'>;
  onRetry: () => void;
  isRetrying?: boolean;
  /** Where the header's Back lands when this state has no history to pop. */
  backFallback?: Href;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const notFound = kind === 'not-found';

  return (
    <PlatformErrorScreen
      title={title}
      eyebrow={eyebrow}
      backFallback={backFallback}
      variant={notFound ? 'not-found' : 'permission'}
      message={t(
        notFound
          ? 'organization.boundary.unavailableDescription'
          : 'organization.boundary.accessDeniedDescription'
      )}
      action={
        <View className="gap-3">
          {/* Leaving is the recovery this surface leads with, so it holds the
              one filled control: dark `--primary` is the brand yellow that
              glares on the near-black page, so dark takes the muted olive
              `--selection` with its own foreground ink. Retry only re-resolves
              the membership, so it stays the outlined secondary. */}
          <Button
            className="bg-primary dark:bg-selection"
            accessibilityLabel={t('organization.boundary.backToProfile')}
            onPress={() => {
              router.replace(PROFILE_HREF);
            }}
          >
            <Text className="dark:text-selection-foreground">
              {t('organization.boundary.backToProfile')}
            </Text>
          </Button>
          <Button
            variant="outline"
            loading={isRetrying}
            accessibilityLabel={t('common.retry')}
            onPress={onRetry}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      }
    />
  );
}
