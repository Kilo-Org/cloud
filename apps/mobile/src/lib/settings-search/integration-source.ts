import { useQuery } from '@tanstack/react-query';
import { type Href } from 'expo-router';
import { useMemo } from 'react';

import { type IntegrationSetupStatus } from '@/lib/integrations/integration-rows';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  providerLabelKey,
  visibleIntegrationProviders,
} from '@/lib/integrations/provider-catalog';
import {
  defineSetting,
  type SettingDefinition,
  type SettingsSearchSource,
} from '@/lib/settings-search/definitions';
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
const INTEGRATION_SETTINGS_PATH: Extract<Href, string> =
  '/(app)/(tabs)/(3_profile)/integrations';

/** The hub's own name as the breadcrumb of every result below it. */
const INTEGRATION_SETTINGS_CONTEXT = 'integrations.title';

/** One definition per catalog provider, in the catalog's order. */
export const INTEGRATION_PROVIDER_SETTINGS = {
  github: defineSetting('integrations.github', providerLabelKey('github')),
  slack: defineSetting('integrations.slack', providerLabelKey('slack')),
  gitlab: defineSetting('integrations.gitlab', providerLabelKey('gitlab')),
  discord: defineSetting('integrations.discord', providerLabelKey('discord')),
  linear: defineSetting('integrations.linear', providerLabelKey('linear')),
  bitbucket: defineSetting('integrations.bitbucket', providerLabelKey('bitbucket')),
} satisfies Record<IntegrationProvider, SettingDefinition>;

/** Whether a setup-status platform is one the mobile catalog can render. */
function isIntegrationProvider(platform: string): platform is IntegrationProvider {
  return INTEGRATION_PROVIDERS.some(provider => provider === platform);
}

/**
 * The providers the hub's setup-status read reports as installed, narrowed to
 * the providers mobile lists. A provider the read omitted was never installed
 * for the owner, which is what `visibleIntegrationProviders` expects.
 */
function installedIntegrationProviders(
  statuses?: readonly IntegrationSetupStatus[]
): Partial<Record<IntegrationProvider, boolean>> {
  const installed: Partial<Record<IntegrationProvider, boolean>> = {};
  for (const status of statuses ?? []) {
    if (isIntegrationProvider(status.platform)) {
      installed[status.platform] = status.installed === true;
    }
  }
  return installed;
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
    settings: visibleIntegrationProviders(
      'personal',
      installedIntegrationProviders(statuses)
    ).map(provider => INTEGRATION_PROVIDER_SETTINGS[provider]),
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
