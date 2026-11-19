import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { LowBalanceAlertForm } from '@/components/organization/low-balance-alert-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { cn } from '@/lib/utils';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';

/** The field's own 44pt box under the loading fill. */
const FIELD_FILL_CLASS = 'w-full rounded-md bg-muted-soft';

export function LowBalanceAlertScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);

  // isPending (no data AND no error) rather than isLoading: an offline
  // paused fetch has isLoading false but no data — it must show the skeleton
  // instead of rendering nothing, while a real error still reaches QueryError.
  // The organizationId guard keeps a disabled query (null org, isPending
  // forever) falling through to OrganizationBoundary below.
  if (isResolving || (organizationId != null && orgWithMembers.isPending)) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.lowBalanceAlert.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          showsVerticalScrollIndicator={false}
        >
          <RowGroup>
            <RowSkeleton trailing="switch" />
          </RowGroup>
          <View className="gap-1.5">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_FILL_CLASS)} />
          </View>
          <View className="gap-1.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_FILL_CLASS)} />
          </View>
        </TabScreenScrollView>
      </View>
    );
  }
  if (organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('organization.lowBalanceAlert.title')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }
  if (!isMoneyRole(role)) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.lowBalanceAlert.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <PermissionDenied
          description={t('organization.lowBalanceAlert.permissionDenied')}
          showBack={false}
        />
      </View>
    );
  }

  if (orgWithMembers.isError && !orgWithMembers.data) {
    return (
      <View className="flex-1 bg-background">
        {/* Nothing to commit until the read answers, so the header only goes
            back; the retry lives in the error block below. */}
        <ScreenHeader
          title={t('organization.lowBalanceAlert.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <QueryError
          className="bg-background"
          onRetry={() => void orgWithMembers.refetch()}
          isRetrying={orgWithMembers.isFetching}
        />
      </View>
    );
  }

  if (!orgWithMembers.data) {
    return null;
  }
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('organization.lowBalanceAlert.title')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
      <TabScreenScrollView
        // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <LowBalanceAlertForm
          organizationId={organizationId}
          settings={orgWithMembers.data.settings}
          canManageBilling={isMoneyRole(role)}
        />
      </TabScreenScrollView>
    </View>
  );
}
