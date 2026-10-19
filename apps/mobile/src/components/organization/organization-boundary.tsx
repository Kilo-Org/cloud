import { type Href, useRouter } from 'expo-router';
import { Building2, Globe, type LucideIcon } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useContextPicker } from '@/components/context-control';
import { openExternalUrl } from '@/lib/external-link';
import { WEB_BASE_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

type OrganizationBoundaryProps = Readonly<{
  /** Full-screen callers pass a title for the `ScreenHeader`; sheets omit it and own no chrome. */
  title?: string;
  /** Explicit org id (e.g. deep-link `?org=`) replacing the persisted selection for this render. */
  organizationIdOverride?: string;
  /** Overrides the default boundary icon (PR-review passes its own glyph). */
  icon?: LucideIcon;
}>;

/**
 * Content shown in place of an organization screen or sheet when the org
 * context isn't ready to render the real content — never renders `null`, so
 * the route is never blank. Three distinct cases, in priority order:
 * 1. `isResolving` — identity/org-list still loading, brief spinner.
 * 2. `isError` — `organizations.list` itself failed to fetch; this is
 *    retryable and must NOT be conflated with a stale org selection.
 * 3. otherwise — the list loaded fine but the persisted `organizationId`
 *    doesn't resolve to a membership. Three settled states, mutually
 *    exclusive:
 *    - no memberships at all → the account has no organization; the action
 *      opens the web organizations page (create/join live there), and Back
 *      to profile stays as the plain exit.
 *    - memberships exist but nothing is selected → the action opens the
 *      context picker sheet, the same account switcher the composer uses.
 *    - a deep-link override absent from the list is access-denied; a stale
 *      persisted selection keeps the older "unavailable" copy.
 * Calls `useOrgBoundary()` itself — cheap, context/query-cache backed — so
 * callers only need to pass a `title` for full screens (sheets omit it).
 */
export function OrganizationBoundary({
  title,
  organizationIdOverride,
  icon = Building2,
}: OrganizationBoundaryProps = {}) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, org, orgs, isResolving, isError, isFetching, refetch } =
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
    // Four distinct settled states, mutually exclusive, decided first by
    // whether the account has any memberships at all:
    // 1. no memberships — the account has no organization (nothing selected,
    //    a stale selection, or an absent deep-link override all look the
    //    same here); the web organizations page owns create/join, so the
    //    boundary sends the reader there instead of a profile control that
    //    does not exist.
    // 2. memberships exist but the resolved selection renders nothing —
    //    nothing selected or a stale persisted selection; open the context
    //    picker so the reader can actually make the choice.
    // 3. a deep-link override absent from a non-empty member list — access
    //    denied; the account has organizations, just not that one.
    // 4. defensive fallback for a resolved selection the callers would not
    //    route here — org unavailable.
    const backToProfileAction = (
      <Button
        variant="outline"
        onPress={() => {
          router.replace(PROFILE_HREF);
        }}
      >
        <Text>{t('organization.boundary.backToProfile')}</Text>
      </Button>
    );
    const hasOrganizations = (orgs?.length ?? 0) > 0;
    const isAbsentOverride = organizationIdOverride != null && org == null;
    if (!hasOrganizations && !isAbsentOverride) {
      const openWebOrganizations = () => {
        void openExternalUrl(`${WEB_BASE_URL}/organizations`, {
          label: t('organization.boundary.openWebOrganizations'),
        });
      };
      content = (
        <EmptyState
          icon={Building2}
          title={t('organization.boundary.noOrganization')}
          description={t('organization.boundary.noOrganizationDescription')}
          action={
            <View className="gap-3">
              <Button onPress={openWebOrganizations}>
                <View className="flex-row items-center gap-2">
                  <Globe size={18} color={colors.primaryForeground} />
                  <Text>{t('organization.boundary.openWebOrganizations')}</Text>
                </View>
              </Button>
              {backToProfileAction}
            </View>
          }
        />
      );
    } else if (organizationId == null || (organizationIdOverride == null && org == null)) {
      content = <OrganizationPickerBoundaryState icon={icon} backAction={backToProfileAction} />;
    } else if (organizationIdOverride != null && org == null) {
      content = (
        <EmptyState
          icon={icon}
          title={t('common.accessDenied')}
          description={t('organization.boundary.accessDeniedDescription')}
          action={backToProfileAction}
        />
      );
    } else {
      content = (
        <EmptyState
          icon={icon}
          title={t('organization.boundary.organizationUnavailable')}
          description={t('organization.boundary.unavailableDescription')}
          action={backToProfileAction}
        />
      );
    }
  }

  if (title == null) {
    return content;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      {content}
    </View>
  );
}

/**
 * The settled "memberships exist, nothing selected" state. The boundary's
 * action opens the same context picker sheet the composer's account control
 * uses, so the reader can actually make the selection the heading asks for;
 * `useContextPicker` owns the sheet element the caller's tree must keep
 * mounted alongside the empty state.
 */
function OrganizationPickerBoundaryState({
  icon,
  backAction,
}: Readonly<{ icon: LucideIcon; backAction?: ReactNode }>) {
  const { t } = useTranslation();
  const { orgs } = useOrgBoundary();
  const { openPicker, picker } = useContextPicker(orgs);

  return (
    <>
      {picker}
      <EmptyState
        icon={icon}
        title={t('organization.boundary.selectOrganization')}
        description={t('organization.boundary.selectDescriptionWithOrganizations')}
        action={
          <View className="gap-3">
            <Button
              onPress={() => {
                openPicker();
              }}
            >
              <Text>{t('organization.boundary.chooseAccount')}</Text>
            </Button>
            {backAction}
          </View>
        }
      />
    </>
  );
}
