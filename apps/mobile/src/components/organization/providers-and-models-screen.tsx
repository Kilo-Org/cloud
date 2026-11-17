import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ModelAccessForm } from '@/components/organization/model-access-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Lock } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useOrgAvailableModels,
  useOrgGatewaySettings,
  useOrgModelCatalog,
} from '@/lib/hooks/use-org-settings-queries';
import { useOrgBoundary, useOrgWithMembers } from '@/lib/hooks/use-organization-queries';

const TITLE_KEY = 'organization.settingsOnWeb.providersAndModels';

/**
 * The organization's providers and models, natively: the model allow/deny
 * policy the web page's Models and Providers tabs edit, plus the gateway
 * settings its Gateways tab owns. The web page's Auto routing tab is not here:
 * its editor reads HTTP endpoints outside the organization router.
 */
export function OrganizationProvidersAndModelsScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const enterprise = org?.plan === 'enterprise';
  const membership = useOrgWithMembers(organizationId);
  const models = useOrgAvailableModels(organizationId, enterprise);
  const catalog = useOrgModelCatalog(enterprise);
  const gateway = useOrgGatewaySettings(organizationId, enterprise);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t(TITLE_KEY)} />;
  }

  if (!enterprise) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <EmptyState
          className="bg-background"
          icon={Lock}
          title={t('organizationModelAccess.enterpriseOnlyTitle')}
          description={t('organizationModelAccess.enterpriseOnly')}
        />
      </View>
    );
  }

  if (membership.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        {membership.isError ? (
          <QueryError
            className="bg-background"
            message={t('organizationModelAccess.loadError')}
            onRetry={() => void membership.refetch()}
            isRetrying={membership.isFetching}
          />
        ) : (
          <View className="gap-3 px-4 pt-4">
            <Skeleton className="h-10 w-full rounded-lg bg-muted-soft" />
            <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
          </View>
        )}
      </View>
    );
  }

  if (models.isPending || catalog.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <View className="gap-3 px-4 pt-4">
          <Skeleton className="h-10 w-full rounded-lg bg-muted-soft" />
          <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
        </View>
      </View>
    );
  }

  const retry = () => {
    void membership.refetch();
    void models.refetch();
    void catalog.refetch();
    void gateway.refetch();
  };

  if (models.isError && models.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <QueryError
          className="bg-background"
          message={t('organizationModelAccess.loadError')}
          onRetry={retry}
          isRetrying={models.isFetching}
        />
      </View>
    );
  }

  // The catalog is the heaviest call on the screen and the one the saved lists
  // do not need: the organization's own models and both saved lists come from
  // the membership and available-models payloads. When it fails, the form still
  // opens on what the phone already has and offers a retry for the rest.
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t(TITLE_KEY)} />
      <ModelAccessForm
        organizationId={organizationId}
        canEdit={canManageOrganization(role)}
        models={models.data.data}
        catalog={catalog.data ?? []}
        catalogUnavailable={catalog.data == null && catalog.isError}
        catalogIsFetching={catalog.isFetching}
        onRetryCatalog={() => void catalog.refetch()}
        providerAllowList={membership.data.settings.provider_allow_list}
        modelDenyList={membership.data.settings.model_deny_list}
        gateway={gateway.data}
        gatewayIsError={gateway.isError}
        gatewayIsFetching={gateway.isFetching}
        onRetryGateway={() => void gateway.refetch()}
      />
    </View>
  );
}
