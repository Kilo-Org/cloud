import 'server-only';

import { normalizeModelId } from '@/lib/model-utils';
import {
  fetchLatestModelsByProviderSnapshotFromDb,
  getProviderSlugsForModel,
} from '@/lib/providers/openrouter/models-by-provider-index.server';
import {
  isAllowedByExactOrNamespaceWildcard,
  isAllowedByProviderMembershipWildcard,
  prepareModelAllowList,
} from '@/lib/model-allow.shared';

export type GetProviderSlugsForModel = (modelId: string) => Promise<ReadonlySet<string>>;

type ProviderAwareAllowPredicateOptions = {
  getProviderSlugsForModel?: GetProviderSlugsForModel;
};

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

export function createProviderAwareModelAllowPredicate(
  allowList: string[],
  options?: ProviderAwareAllowPredicateOptions
): ProviderAwareAllowPredicate {
  if (allowList.length === 0) {
    return async () => true;
  }

  const { allowListSet, wildcardProviderSlugs } = prepareModelAllowList(allowList);

  const getProvidersForModel = options?.getProviderSlugsForModel ?? getProviderSlugsForModel;

  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);

    if (isAllowedByExactOrNamespaceWildcard(normalizedModelId, allowListSet)) {
      return true;
    }

    // 3) Provider-membership wildcard match
    if (wildcardProviderSlugs.size === 0) {
      return false;
    }

    const providersForModel = await getProvidersForModel(normalizedModelId);
    return isAllowedByProviderMembershipWildcard(providersForModel, wildcardProviderSlugs);
  };
}

export async function createDenyLists(
  model_allow_list: string[] | undefined,
  provider_allow_list: string[] | undefined
) {
  if (!model_allow_list && !provider_allow_list) {
    return undefined;
  }
  const data = await fetchLatestModelsByProviderSnapshotFromDb();
  if (!data) {
    return undefined;
  }
  const isAllowed = model_allow_list
    ? createProviderAwareModelAllowPredicate(model_allow_list)
    : undefined;
  const model_deny_list = new Set<string>();
  const provider_deny_list = new Set<string>();
  for (const provider of data.providers) {
    if (
      provider_allow_list &&
      provider_allow_list.length > 0 &&
      !provider_allow_list.includes(provider.slug)
    ) {
      provider_deny_list.add(provider.slug);
    }
    for (const model of provider.models) {
      if (isAllowed && !(await isAllowed(model.slug))) {
        model_deny_list.add(model.slug);
      }
    }
  }
  return { model_deny_list: [...model_deny_list], provider_deny_list: [...provider_deny_list] };
}
