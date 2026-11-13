import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { ScreenHeader } from '@/components/screen-header';
import { UsageContent } from '@/components/usage/usage-content';
import { isMoneyRole, useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useOrgDeepLinkSelection } from '@/lib/hooks/use-org-deep-link-selection';
import { type UsageScope } from '@/lib/hooks/use-usage-analytics';

type OrganizationUsageScreenProps = Readonly<{
  /** Explicit org id from a deep link; absent uses the persisted selection. */
  organizationIdOverride?: string;
}>;

/**
 * One organization's usage. Web's dashboard lets owner and billing_manager read
 * the whole organization and shows every other role only their own usage inside
 * it, and the server enforces the same split, so the scope follows the role.
 */
export function OrganizationUsageScreen({
  organizationIdOverride,
}: OrganizationUsageScreenProps = {}) {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving, contextOrganizationId, orgs, isLoading } =
    useOrgBoundary(organizationIdOverride);
  // The link's organization becomes the selection once it resolves to a
  // membership; a foreign id writes nothing and stays on the boundary's state.
  useOrgDeepLinkSelection({
    orgParam: organizationIdOverride,
    contextOrganizationId,
    orgs,
    isOrgListLoading: isLoading,
  });
  const orgWide = isMoneyRole(role);
  const scope = useMemo<UsageScope | null>(
    () => (organizationId == null ? null : { kind: 'organization', organizationId, orgWide }),
    [organizationId, orgWide]
  );

  if (isResolving || organizationId == null || org == null || scope == null) {
    return (
      <OrganizationBoundary
        title={t('usage.orgTitle')}
        organizationIdOverride={organizationIdOverride}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('usage.orgTitle')} />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pb-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <UsageContent scope={scope} />
      </DetailScreenScrollView>
    </View>
  );
}
