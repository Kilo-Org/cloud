import { type OrganizationRole } from '@kilocode/app-shared/organizations';
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
import { openAppShellHandoff } from '@/lib/app-shell-handoff';
import {
  useDisconnectIntegration,
  useGitHubConnections,
  useIntegrationConnect,
  useIntegrationStatuses,
} from '@/lib/hooks/use-integrations';
import { useBitbucketIntegrationStatus } from '@/lib/hooks/use-bitbucket';
import { bitbucketConnectHref } from '@/lib/bitbucket-connect-navigation';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useOrgDeepLinkSelection } from '@/lib/hooks/use-org-deep-link-selection';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { buildIntegrationRows, type IntegrationRow } from '@/lib/integrations/integration-rows';
import {
  blockedConnectionRoles,
  type IntegrationProvider,
  integrationScope,
  providerLabelKey,
} from '@/lib/integrations/provider-catalog';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { isPermissionDeniedError, trpcErrorVariant } from '@/lib/trpc-error';

/**
 * The catalog key naming who can change the connections the viewer cannot. The
 * hub names only the roles that can change at least one blocked row, so the
 * sentence follows the providers the viewer is actually shut out of.
 */
export function blockedNoteKey(roles: readonly OrganizationRole[]): string | null {
  if (roles.length === 0) {
    return null;
  }
  const namesAdmin = roles.includes('admin');
  const namesBilling = roles.includes('billing_manager');
  if (namesAdmin && namesBilling) {
    return 'integrations.managedByOwnerAdminOrBilling';
  }
  if (namesAdmin) {
    return 'integrations.managedByOwnerOrAdmin';
  }
  if (namesBilling) {
    return 'integrations.managedByOwnerOrBilling';
  }
  return 'integrations.managedByOwner';
}

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
  const pushOnce = useSinglePushRoute();
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
  // Every render past the gate below has the organization when the scope is an
  // organization, so the header names it without a second lookup.
  const organizationName = scope === 'organization' ? boundary.org?.organizationName : undefined;

  useRouteForegroundRefresh([
    [['platformIntegrations']],
    [['githubApps', 'listIntegrations']],
    // The Bitbucket status read names the connection its row disconnects, so a
    // read that failed here recovers when the route regains foreground.
    [['organizations', 'bitbucket', 'getStatus']],
  ]);

  const statuses = useIntegrationStatuses(organizationId, scopeResolved);
  const githubConnections = useGitHubConnections(organizationId, scopeResolved);
  // The setup-status read reports whether a Bitbucket workspace is installed but
  // never the integration row, which is the only id a native disconnect names.
  const bitbucket = useBitbucketIntegrationStatus(organizationId, scopeResolved);
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
        backFallback={PROFILE_TAB_HREF}
        organizationIdOverride={organizationId}
      />
    );
  }

  if (statuses.isPending) {
    return <IntegrationsSkeleton organizationName={organizationName} />;
  }

  // `data` survives a failed background refetch, so the loaded rows stay put
  // once they exist; only a read that never landed takes over the screen.
  if (statuses.isError && statuses.data == null) {
    if (isPermissionDeniedError(statuses.error)) {
      return <PermissionDenied description={t('integrations.permissionDenied')} />;
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('integrations.title')}
          subtitle={organizationName}
          backFallback={PROFILE_TAB_HREF}
        />
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
    bitbucketIntegrationId: bitbucket.data?.integrationId ?? null,
    bitbucketIntegrationPending: bitbucket.isPending,
  });
  const role = boundary.role ?? undefined;
  // The hub names the roles once, above the list, instead of under every row
  // that offers the viewer no action. It names only the roles that can change at
  // least one of those rows, because the provider role sets differ.
  const noteKey = blockedNoteKey(blockedConnectionRoles({ rows, scope, role }));

  // A GitHub row whose installations the hub cannot name is the only row with a
  // web management link, and it opens the app-shell integration page through a
  // one-time hand-off. A Bitbucket row has no web page here: its connect sheet
  // is the app's own surface for that provider, and it states the connection's
  // state and the roles that may change it for a viewer without them.
  const manageRowOnWeb = (provider: IntegrationProvider) => {
    if (provider === 'bitbucket') {
      if (organizationId) {
        pushOnce(bitbucketConnectHref(organizationId));
      }
      return;
    }
    void openAppShellHandoff(
      {
        page: 'integration',
        platform: provider,
        ...(organizationId ? { organizationId } : {}),
      },
      { label: t(providerLabelKey(provider)) }
    );
  };

  const connectProvider = (provider: IntegrationProvider) => {
    if (provider === 'bitbucket') {
      if (organizationId) {
        pushOnce(bitbucketConnectHref(organizationId));
      }
      return;
    }
    void connect(provider);
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
          integrationId: row.disconnectIntegrationId,
        });
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('integrations.title')}
        subtitle={organizationName}
        backFallback={PROFILE_TAB_HREF}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t('integrations.subtitle')}</Text>
          {noteKey ? <Text className="text-xs text-muted-foreground">{t(noteKey)}</Text> : null}
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
                    connectProvider(row.provider);
                  }}
                  onDisconnect={() => {
                    requestDisconnect(row);
                  }}
                  onOpenOnWeb={() => {
                    manageRowOnWeb(row.provider);
                  }}
                  onRetryConnection={() => void bitbucket.refetch()}
                  retryingConnection={bitbucket.isFetching}
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
function IntegrationsSkeleton({ organizationName }: Readonly<{ organizationName?: string }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('integrations.title')}
        subtitle={organizationName}
        backFallback={PROFILE_TAB_HREF}
      />
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
