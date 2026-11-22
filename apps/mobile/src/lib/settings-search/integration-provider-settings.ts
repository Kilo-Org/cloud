import { type IntegrationProvider, providerLabelKey } from '@/lib/integrations/provider-catalog';
import { defineSetting } from '@/lib/settings-search/definitions';

/** The visible provider label and stable row target, shared with the search index. */
export function integrationProviderSetting(provider: IntegrationProvider) {
  return defineSetting(`integrations.${provider}`, providerLabelKey(provider));
}
