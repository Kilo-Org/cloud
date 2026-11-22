import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type IntegrationSetupStatus } from '@/lib/integrations/integration-rows';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  visibleIntegrationProviders,
} from '@/lib/integrations/provider-catalog';
import { type SettingsPath, type SettingsSearchSource } from '@/lib/settings-search/definitions';
import { INTEGRATION_PROVIDER_SETTINGS } from '@/lib/settings-search/integration-provider-settings';
import { useTRPC } from '@/lib/trpc';

/**
 * The search index for the integrations hub.
 *
 * Profile opens the hub without an `org` parameter, so only the personal scope
 * is indexed: `visibleIntegrationProviders` keeps the catalog's own rules, which
 * leave out the organization-only Bitbucket row and Discord until it is
 * installed. A result never connects or disconnects anything; it opens the hub
 * and highlights the provider's own row.
 *
 * Every definition is stable and keyed by the catalog provider, so the row's
 * visible name and its search result cannot drift apart, and the id a result
 * carries is the id the destination row answers to.
 */

/** The personal integrations hub in the Profile tab. */
const INTEGRATION_SETTINGS_PATH: SettingsPath = '/(app)/(tabs)/(3_profile)/integrations';

/** The hub's own name as the breadcrumb of every result below it. */
const INTEGRATION_SETTINGS_CONTEXT = 'integrations.title';

/** Whether a setup-status platform is one the mobile catalog can render. */
function isIntegrationProvider(platform: string): platform is IntegrationProvider {
  return INTEGRATION_PROVIDERS.some(provider => provider === platform);
}

/**
 * The providers the hub's setup-status read reports as installed, narrowed to
 * the providers mobile lists. A provider the read omitted was never installed
 * for the owner, which is what `visibleIntegrationProviders` expects.
 */
function installedIntegrationProviders(statuses?: readonly IntegrationSetupStatus[]) {
  const installed: [IntegrationProvider, boolean][] = [];
  for (const status of statuses ?? []) {
    if (isIntegrationProvider(status.platform)) {
      installed.push([status.platform, status.installed]);
    }
  }
  return Object.fromEntries(installed);
}

/**
 * The personal hub's search source. `statuses` is the hub's own setup-status
 * read when it is already cached, so a provider the catalog hides until it is
 * installed (Discord) is indexed only when that row would actually exist.
 * Without cache the source holds the stable rows.
 */
function buildIntegrationSearchSource(
  statuses?: readonly IntegrationSetupStatus[]
): SettingsSearchSource {
  return {
    context: [INTEGRATION_SETTINGS_CONTEXT],
    path: INTEGRATION_SETTINGS_PATH,
    settings: visibleIntegrationProviders('personal', installedIntegrationProviders(statuses)).map(
      provider => INTEGRATION_PROVIDER_SETTINGS[provider]
    ),
  };
}

/**
 * The Profile screen's integrations source. The setup-status read is observed
 * with `enabled: false`, so this never starts a request: it reads the cache the
 * hub's own read already filled and re-renders the source when that cache
 * changes. Discord therefore appears once the hub has reported it installed,
 * and never for an owner who has not installed it.
 */
export function useIntegrationSearchSource(): SettingsSearchSource {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.platformIntegrations.listSetupStatus.queryOptions({}, { enabled: false }),
  });
  return useMemo(() => buildIntegrationSearchSource(data), [data]);
}
