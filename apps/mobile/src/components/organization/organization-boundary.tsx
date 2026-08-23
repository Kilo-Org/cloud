import { type Href, useRouter } from 'expo-router';
import { Building2 } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

type OrganizationBoundaryProps = Readonly<{
  /** Full-screen callers pass a title for the `ScreenHeader`; sheets omit it and own no chrome. */
  title?: string;
  /** Explicit org id (e.g. deep-link `?org=`) replacing the persisted selection for this render. */
  organizationIdOverride?: string;
}>;

/**
 * Content shown in place of an organization screen or sheet when the org
 * context isn't ready to render the real content — never renders `null`, so
 * the route is never blank. Three distinct cases, in priority order:
 * 1. `isResolving` — identity/org-list still loading, brief spinner.
 * 2. `isError` — `organizations.list` itself failed to fetch; this is
 *    retryable and must NOT be conflated with a stale org selection.
 * 3. otherwise — the list loaded fine but the persisted `organizationId`
 *    doesn't resolve to a membership: either nothing was ever selected, or
 *    the selected org is stale (deleted / user removed). Each gets its own
 *    copy.
 * Calls `useOrgBoundary()` itself — cheap, context/query-cache backed — so
 * callers only need to pass a `title` for full screens (sheets omit it).
 */
export function OrganizationBoundary({
  title,
  organizationIdOverride,
}: OrganizationBoundaryProps = {}) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, isResolving, isError, isFetching, refetch } =
    useOrgBoundary(organizationIdOverride);

  let content: ReactNode = null;
  if (isResolving) {
    content = (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if (isError) {
    content = (
      <QueryError
        title={t('organization.boundary.loadErrorTitle')}
        message={t('organization.boundary.loadErrorMessage')}
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else {
    const noSelection = organizationId == null;
    content = (
      <EmptyState
        icon={Building2}
        title={
          noSelection
            ? t('organization.boundary.selectOrganization')
            : t('organization.boundary.organizationUnavailable')
        }
        description={
          noSelection
            ? t('organization.boundary.selectDescription')
            : t('organization.boundary.unavailableDescription')
        }
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.replace(PROFILE_HREF);
            }}
          >
            <Text>{t('organization.boundary.backToProfile')}</Text>
          </Button>
        }
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      {title != null && <ScreenHeader title={title} />}
      {content}
    </View>
  );
}
