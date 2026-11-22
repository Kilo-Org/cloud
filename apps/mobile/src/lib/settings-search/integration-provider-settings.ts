import {
  INTEGRATION_PROVIDERS,
  type IntegrationProvider,
  providerLabelKey,
} from '@/lib/integrations/provider-catalog';
import { defineSetting, type SettingDefinition } from '@/lib/settings-search/definitions';

/** One provider's search definition, keyed by the id its own row answers to. */
function providerSetting(
  provider: IntegrationProvider
): readonly [IntegrationProvider, SettingDefinition] {
  return [provider, defineSetting(`integrations.${provider}`, providerLabelKey(provider))];
}

/**
 * One search definition per catalog provider, in the catalog's order, so the
 * hub's rows and its search results cannot drift apart: the label is the same
 * catalog key the row renders.
 *
 * This module stays free of the hub's setup-status read, so the hub can import
 * the definitions without loading the tRPC/query layer the search source adds.
 */
export const INTEGRATION_PROVIDER_SETTINGS = Object.fromEntries(
  INTEGRATION_PROVIDERS.map(providerSetting)
);
