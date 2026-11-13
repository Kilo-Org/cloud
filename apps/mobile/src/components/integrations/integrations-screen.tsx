import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { IntegrationProviderRow } from '@/components/integrations/integration-provider-row';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { WEB_BASE_URL } from '@/lib/config';
import {
  useDisconnectIntegration,
  useGitHubConnections,
  useIntegrationConnect,
  useIntegrationStatuses,
} from '@/lib/hooks/use-integrations';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useOrgDeepLinkSelection } from '@/lib/hooks/use-org-deep-link-selection';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { getIntegrationPageUrl } from '@/lib/integration-urls';
import { buildIntegrationRows, type IntegrationRow } from '@/lib/integrations/integration-rows';
import {
  canManageProvider,
  type IntegrationProvider,
  integrationScope,
  providerLabelKey,
} from '@/lib/integrations/provider-catalog';
import { isPermissionDeniedError, trpcErrorVariant } from '@/lib/trpc-error';

type IntegrationsScreenProps = Readonly<{
  /** Organization scope from the route; absent is the caller's personal scope. */
  organizationId?: string;
}>;

/**
 * The integrations hub: one row per service, the account it is connected to,
 * and the action the viewer may take. Connect leaves the app for the web page
 * that owns the OAuth flow, because the provider callbacks land there; the
 * screen refreshes when the browser returns.
 */
export function IntegrationsScreen({ organizationId }: IntegrationsScreenProps) {
  const { t } = useTranslation();
  const scope = integrationScope(organizationId);
  const boundary = useOrgBoundary(organizationId);
  // The link's organization becomes the selection once it resolves to a
  // membership; a foreign id writes nothing and stays on the boundary's state.
  useOrgDeepLinkSelection({
    orgParam: organizationId,
    contextOrganizationId: boundary.contextOrganizationId,
    orgs: boundary.orgs,
    isOrgListLoading: boundary.isLoading,
  });
  // A deep link can name an organization the viewer is not a member of: the
  // boundary owns that case, so no read fires until membership is confirmed.
  const scopeResolved = scope === 'personal' || (!boundary.isResolving && boundary.org != null);

  useRouteForegroundRefresh([[['platformIntegrations']], [['githubApps', 'listIntegrations']]]);

  const statuses = useIntegrationStatuses(organizationId, scopeResolved);
  const githubConnections = useGitHubConnections(organizationId, scopeResolved);
  const disconnect = useDisconnectIntegration(organizationId);
  const { confirm, dialog } = useConfirmDialog();
  const { pendingProvider, connect } = useIntegrationConnect({
    organizationId,
    onReturned: async () => {
      await Promise.all([statuses.refetch(), githubConnections.refetch()]);
    },
  });

  if (!scopeResolved) {
    return (
      <OrganizationBoundary
        title={t('integrations.title')}
        organizationIdOverride={organizationId}
      />
    );
  }

  if (statuses.isPending) {
    return <IntegrationsSkeleton />;
  }

  // `data` survives a failed background refetch, so the loaded rows stay put
  // once they exist; only a read that never landed takes over the screen.
  if (statuses.isError && statuses.data == null) {
    if (isPermissionDeniedError(statuses.error)) {
      return <PermissionDenied description={t('integrations.permissionDenied')} />;
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('integrations.title')} />
        <QueryError
          className="bg-background"
          variant={trpcErrorVariant(statuses.error)}
          title={t('integrations.couldNotLoad')}
          onRetry={() => void statuses.refetch()}
          isRetrying={statuses.isFetching}
        />
      </View>
    );
  }

  const rows = buildIntegrationRows({
    scope,
    statuses: statuses.data,
    githubConnections: githubConnections.data ?? [],
    githubConnectionsPending: githubConnections.isPending,
  });
  const role = boundary.role ?? undefined;
  const canActOnRow = (row: IntegrationRow) =>
    canManageProvider({
      provider: row.provider,
      scope,
      role,
      action: 'connect',
      installed: row.installed,
    }) || canManageProvider({ provider: row.provider, scope, role, action: 'disconnect' });
  // The hint names the role that can change the connections, so it only shows
  // when no row offers the viewer any action at all.
  const showMemberHint =
    scope === 'organization' && rows.length > 0 && !rows.some(row => canActOnRow(row));

  const openProviderPage = (provider: IntegrationProvider) => {
    void openExternalUrl(getIntegrationPageUrl(WEB_BASE_URL, provider, organizationId), {
      label: t(providerLabelKey(provider)),
    });
  };

  const requestDisconnect = (row: IntegrationRow) => {
    const provider = t(providerLabelKey(row.provider));
    confirm({
      title: t('integrations.disconnectTitle', { provider }),
      message: t('integrations.disconnectMessage', { provider }),
      confirmLabel: t('integrations.disconnect'),
      onConfirm: () => {
        disconnect.mutate({
          provider: row.provider,
          githubIntegrationId: row.githubIntegrationId,
        });
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('integrations.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t('integrations.subtitle')}</Text>
          {rows.some(row => row.installed) ? null : (
            <Text className="text-xs text-muted-foreground">{t('integrations.emptyHint')}</Text>
          )}
          {showMemberHint ? (
            <Text className="text-xs text-muted-foreground">{t('integrations.memberHint')}</Text>
          ) : null}
          {rows.length > 0 ? (
            <View className="rounded-lg bg-secondary px-3">
              {rows.map((row, index) => (
                <IntegrationProviderRow
                  key={row.provider}
                  row={row}
                  scope={scope}
                  role={role}
                  connecting={pendingProvider === row.provider}
                  disconnecting={
                    disconnect.isPending && disconnect.variables.provider === row.provider
                  }
                  onConnect={() => {
                    void connect(row.provider);
                  }}
                  onDisconnect={() => {
                    requestDisconnect(row);
                  }}
                  onManageOnWeb={() => {
                    openProviderPage(row.provider);
                  }}
                  last={index === rows.length - 1}
                />
              ))}
            </View>
          ) : null}
        </View>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}

/** Loading placeholder at the loaded rows' size, so the swap moves nothing. */
function IntegrationsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('integrations.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
          <Skeleton className="h-4 w-3/4 rounded" />
          <View className="rounded-lg bg-secondary px-3">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="my-3 h-9 w-full rounded" />
            ))}
          </View>
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
