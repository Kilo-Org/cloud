import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { GuardrailsForm } from '@/components/organization/guardrails-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Lock } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { useOrgGuardrails } from '@/lib/hooks/use-org-settings-queries';
import { useOrgBoundary, useOrgWithMembers } from '@/lib/hooks/use-organization-queries';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

const TITLE_KEY = 'organizationGuardrails.title';

/**
 * The organization's AI guardrails, natively: the input guardrail and the
 * output guardrail the web page configures, with the same detectors, the same
 * options, and the same cap on saved rules. The form itself lives in
 * `guardrails-form.tsx`; this screen resolves the organization boundary and the
 * payloads it needs.
 */
export function OrganizationGuardrailsScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const membership = useOrgWithMembers(organizationId);
  const allowed = canManageOrganization(role);
  const guardrailsAvailable = membership.data?.settings.kilo_encrypt === true;
  const query = useOrgGuardrails(organizationId, allowed && guardrailsAvailable);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t(TITLE_KEY)} />;
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
        <PermissionDenied description={t('organizationGuardrails.permissionDenied')} />
      </View>
    );
  }

  if (membership.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
        {membership.isError ? (
          <QueryError
            className="bg-background"
            message={t('organizationGuardrails.loadError')}
            onRetry={() => void membership.refetch()}
            isRetrying={membership.isFetching}
          />
        ) : (
          <View className="gap-3 px-6 pt-4">
            <Skeleton className="h-40 w-full rounded-lg bg-muted-soft" />
            <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
          </View>
        )}
      </View>
    );
  }

  if (!guardrailsAvailable) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
        <EmptyState
          className="bg-background"
          icon={Lock}
          title={t('organizationGuardrails.unavailableTitle')}
          description={t('organizationGuardrails.unavailable')}
          action={
            <Button
              variant="outline"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                void openExternalUrl(`mailto:${SUPPORT_EMAIL}`, {
                  label: t('organizationGuardrails.contactSupport'),
                });
              }}
            >
              <Text>{t('organizationGuardrails.contactSupport')}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  if (query.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
        <View className="gap-3 px-6 pt-4">
          <Skeleton className="h-40 w-full rounded-lg bg-muted-soft" />
          <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
        </View>
      </View>
    );
  }

  if (query.isError && query.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
        <QueryError
          className="bg-background"
          message={t('organizationGuardrails.loadError')}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t(TITLE_KEY)} backFallback={ORGANIZATION_HUB_PATH} />
      <TabScreenScrollView
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName="px-4 gap-4 pt-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <GuardrailsForm organizationId={organizationId} data={query.data} />
      </TabScreenScrollView>
    </View>
  );
}