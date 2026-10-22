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
 * Retry re-resolves the membership: an owner who restores access gets the
 * organization back in place. Back to profile leaves the stale selection behind,
 * exactly like the shared organization boundary's absent-override state.
 */
export function ScopeAccessDeniedScreen({
  title,
  eyebrow,
  kind,
  onRetry,
  isRetrying = false,
}: Readonly<{
  /** ScreenHeader's title: the product name, or the organization's name. */
  title: string;
  eyebrow?: string;
  /** `'not-found'` for an organization that no longer exists. */
  kind: Exclude<OrganizationScopeAccess, 'granted'>;
  onRetry: () => void;
  isRetrying?: boolean;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const notFound = kind === 'not-found';

  return (
    <PlatformErrorScreen
      title={title}
      eyebrow={eyebrow}
      variant={notFound ? 'not-found' : 'permission'}
      message={t(
        notFound
          ? 'organization.boundary.unavailableDescription'
          : 'organization.boundary.accessDeniedDescription'
      )}
      action={
        <View className="gap-3">
          <Button
            variant="outline"
            onPress={onRetry}
            loading={isRetrying}
            accessibilityLabel={t('common.retry')}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
          <Button
            variant="outline"
            accessibilityLabel={t('organization.boundary.backToProfile')}
            onPress={() => {
              router.replace(PROFILE_HREF);
            }}
          >
            <Text>{t('organization.boundary.backToProfile')}</Text>
          </Button>
        </View>
      }
    />
  );
}
