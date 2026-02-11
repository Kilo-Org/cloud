'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import {
  useOrganizationWithMembers,
  useUpdateOrganizationSettings,
} from '@/app/api/organizations/hooks';
import { useOpenRouterModelsAndProviders } from '@/app/api/openrouter/hooks';
import { normalizeModelId } from '@/lib/model-utils';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { OrganizationContextProvider } from '../OrganizationContext';
import { OrganizationPageHeader } from '../OrganizationPageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPrice, getCountryDisplayName } from '@/components/models/util';
import { ModelSelectionStatusBar } from '@/components/models/ModelSelectionStatusBar';
import { toast } from 'sonner';
import { ModelsTab } from '@/components/organizations/providers-and-models/ModelsTab';
import { ProvidersTab } from '@/components/organizations/providers-and-models/ProvidersTab';
import { ModelDetailsDialog } from '@/components/organizations/providers-and-models/ModelDetailsDialog';
import { ProviderDetailsDialog } from '@/components/organizations/providers-and-models/ProviderDetailsDialog';
import type {
  ModelRow,
  ProviderModelRow,
  ProviderOffering,
  ProviderRow,
} from '@/components/organizations/providers-and-models/providersAndModels.types';
import {
  useProvidersAndModelsAllowListsState,
  type ProviderPolicyFilter,
} from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';
import { preferredModels } from '@/lib/models';

type Props = {
  organizationId: string;
  role: OrganizationRole;
};

function EnterpriseOnlyMessage() {
  return (
    <div className="flex justify-center">
      <div className="bg-muted max-w-md rounded-lg border p-8 text-center shadow-sm">
        <h3 className="text-foreground mb-2 text-lg font-medium">Enterprise Feature</h3>
        <p className="text-muted-foreground text-sm">This is an enterprise only feature.</p>
      </div>
    </div>
  );
}

// NOTE: pricing formatting is shared with the model selector UI.

function formatPriceCompact(raw: string): string {
  return formatPrice(raw)
    .replace('/1M tokens', '/1M')
    .replace('/1K tokens', '/1K')
    .replace('/token', '');
}

function normalizeProviderIconUrl(rawUrl: string): string {
  // OpenRouter provider icon URLs are sometimes returned as absolute paths (e.g. "/img/...").
  // In that case, they should be resolved relative to https://openrouter.ai.
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }

  if (rawUrl.startsWith('/')) {
    return `https://openrouter.ai${rawUrl}`;
  }

  return `https://openrouter.ai/${rawUrl}`;
}

type RecommendedThenSourceIndexSortKey = {
  preferredIndex: number | undefined;
  sourceIndex: number;
};

function compareRecommendedThenSourceIndex(
  a: RecommendedThenSourceIndexSortKey,
  b: RecommendedThenSourceIndexSortKey
): number {
  if (a.preferredIndex !== undefined && b.preferredIndex === undefined) return -1;
  if (a.preferredIndex === undefined && b.preferredIndex !== undefined) return 1;

  if (a.preferredIndex !== undefined && b.preferredIndex !== undefined) {
    return a.preferredIndex - b.preferredIndex;
  }

  return a.sourceIndex - b.sourceIndex;
}

export function OrganizationProvidersAndModelsPage({ organizationId, role }: Props) {
  const { assumedRole } = useRoleTesting();
  const isKiloAdmin = assumedRole === 'KILO ADMIN';
  const currentRole = (isKiloAdmin ? 'owner' : assumedRole) ?? role;
  const canEdit = isKiloAdmin || currentRole === 'owner';

  const updateOrganizationSettings = useUpdateOrganizationSettings();

  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const {
    models: openRouterModels,
    providers: openRouterProviders,
    isLoading: isOpenRouterLoading,
  } = useOpenRouterModelsAndProviders();

  const { state, actions, selectors } = useProvidersAndModelsAllowListsState({
    openRouterModels,
    openRouterProviders,
  });

  const preferredIndexByModelId = useMemo(() => {
    const index = new Map<string, number>();
    for (let i = 0; i < preferredModels.length; i++) {
      const modelId = normalizeModelId(preferredModels[i]);
      index.set(modelId, i);
    }
    return index;
  }, []);

  const providerIndex = selectors.modelProvidersIndex;

  const modelRows = useMemo((): ModelRow[] => {
    const rows: ModelRow[] = [];
    for (const model of openRouterModels) {
      const normalizedModelId = normalizeModelId(model.slug);
      const providerSlugs = providerIndex.get(normalizedModelId);

      const sourceIndex = rows.length;
      rows.push({
        modelId: normalizedModelId,
        modelName: model.name,
        providerSlugs: providerSlugs ? [...providerSlugs].sort() : [],
        preferredIndex: preferredIndexByModelId.get(normalizedModelId),
        sourceIndex,
      });
    }

    // Recommended sorting:
    // 1) recommendedModels order
    // 2) otherwise preserve OpenRouter-provided order
    rows.sort(compareRecommendedThenSourceIndex);
    return rows;
  }, [openRouterModels, preferredIndexByModelId, providerIndex]);
  useEffect(() => {
    if (!organizationData) return;
    if (state.status === 'ready') return;
    actions.initFromServer({
      modelAllowList: organizationData.settings?.model_allow_list ?? [],
      providerAllowList: organizationData.settings?.provider_allow_list ?? [],
    });
  }, [actions, organizationData, state.status]);

  const enabledProviderSlugs = selectors.enabledProviderSlugs;
  const allowedModelIds = selectors.allowedModelIds;

  const isLoading = isOpenRouterLoading || state.status !== 'ready';
  const isProvidersLoading = isLoading;
  const hasUnsavedChanges = canEdit && selectors.hasUnsavedChanges;

  const handleToggleProviderEnabled = useCallback(
    (providerSlug: string, nextEnabled: boolean) => {
      if (!canEdit) return;
      actions.toggleProvider({ providerSlug, nextEnabled });
    },
    [actions, canEdit]
  );

  const handleToggleModelAllowed = useCallback(
    (modelId: string, nextAllowed: boolean) => {
      if (!canEdit) return;
      actions.toggleModel({ modelId, nextAllowed });
    },
    [actions, canEdit]
  );

  const handleToggleAllowFutureModelsForProvider = useCallback(
    (providerSlug: string, nextAllowed: boolean) => {
      if (!canEdit) return;
      actions.toggleProviderWildcard({ providerSlug, nextAllowed });
    },
    [actions, canEdit]
  );

  const handleCancelChanges = useCallback(() => {
    if (!canEdit) return;
    actions.resetToInitial();
  }, [actions, canEdit]);

  const handleSaveChanges = useCallback(async () => {
    if (!canEdit) return;
    if (state.status !== 'ready') return;

    try {
      await updateOrganizationSettings.mutateAsync({
        organizationId,
        model_allow_list: state.draftModelAllowList,
        provider_allow_list: state.draftProviderAllowList,
      });

      actions.markSaved();
      toast.success('Success! The providers and models have been updated for your organization.');
    } catch {
      toast.error('Failed to save settings. Please try again.');
    }
  }, [actions, canEdit, organizationId, state, updateOrganizationSettings]);

  const filteredModelRows = useMemo((): ModelRow[] => {
    const normalizedSearch = state.modelSearch.trim().toLowerCase();

    return modelRows.filter(row => {
      if (state.modelSelectedOnly && !allowedModelIds.has(row.modelId)) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      if (row.modelName.toLowerCase().includes(normalizedSearch)) {
        return true;
      }

      if (row.modelId.toLowerCase().includes(normalizedSearch)) {
        return true;
      }

      if (row.providerSlugs.some(slug => slug.toLowerCase().includes(normalizedSearch))) {
        return true;
      }

      return false;
    });
  }, [allowedModelIds, modelRows, state.modelSearch, state.modelSelectedOnly]);

  const infoModel = useMemo((): ModelRow | null => {
    if (!state.infoModelId) return null;
    const row = modelRows.find(r => r.modelId === state.infoModelId);
    return row ?? null;
  }, [modelRows, state.infoModelId]);

  const infoBaseModel = useMemo(() => {
    if (!infoModel) return null;

    const model = openRouterModels.find(m => normalizeModelId(m.slug) === infoModel.modelId);
    return model ?? null;
  }, [infoModel, openRouterModels]);

  const infoOfferings = useMemo((): ProviderOffering[] => {
    if (!infoModel) return [];

    const offerings: ProviderOffering[] = [];
    for (const provider of openRouterProviders) {
      const model = provider.models.find(
        m => m.endpoint && normalizeModelId(m.slug) === infoModel.modelId
      );
      if (!model || !model.endpoint) continue;

      offerings.push({
        providerSlug: provider.slug,
        providerDisplayName: provider.displayName,
        providerIconUrl: provider.icon?.url ? normalizeProviderIconUrl(provider.icon.url) : null,
        trains: provider.dataPolicy.training,
        retainsPrompts: provider.dataPolicy.retainsPrompts,
        promptPrice: model.endpoint.pricing.prompt,
        completionPrice: model.endpoint.pricing.completion,
      });
    }

    offerings.sort((a, b) => a.providerDisplayName.localeCompare(b.providerDisplayName));
    return offerings;
  }, [infoModel, openRouterProviders]);

  const enabledModelCountByProviderSlug = useMemo(() => {
    const map = new Map<string, number>();

    for (const provider of openRouterProviders) {
      let count = 0;
      for (const model of provider.models) {
        if (!model.endpoint) continue;
        if (allowedModelIds.has(normalizeModelId(model.slug))) {
          count++;
        }
      }
      map.set(provider.slug, count);
    }

    return map;
  }, [allowedModelIds, openRouterProviders]);

  const providerRows = useMemo((): ProviderRow[] => {
    const rows: ProviderRow[] = [];
    for (const provider of openRouterProviders) {
      const providerModels = provider.models.filter(m => m.endpoint);
      if (providerModels.length === 0) {
        continue;
      }

      rows.push({
        providerSlug: provider.slug,
        providerDisplayName: provider.displayName,
        providerIconUrl: provider.icon?.url ? normalizeProviderIconUrl(provider.icon.url) : null,
        modelCount: providerModels.length,
        trains: provider.dataPolicy.training,
        retainsPrompts: provider.dataPolicy.retainsPrompts,
        headquarters: provider.headquarters,
        datacenters: provider.datacenters,
      });
    }

    rows.sort((a, b) => a.providerDisplayName.localeCompare(b.providerDisplayName));
    return rows;
  }, [openRouterProviders]);

  const providerLocationOptions = useMemo((): string[] => {
    const locations = new Set<string>();
    for (const provider of providerRows) {
      if (provider.headquarters) {
        locations.add(getCountryDisplayName(provider.headquarters));
      }
      for (const dc of provider.datacenters ?? []) {
        locations.add(getCountryDisplayName(dc));
      }
    }

    return [...locations].sort((a, b) => a.localeCompare(b));
  }, [providerRows]);

  const filteredProviderRows = useMemo((): ProviderRow[] => {
    const normalizedSearch = state.providerSearch.trim().toLowerCase();
    return providerRows.filter(row => {
      if (state.enabledProvidersOnly && !enabledProviderSlugs.has(row.providerSlug)) {
        return false;
      }

      if (state.providerTrainsFilter !== 'all') {
        const wantsTrains = state.providerTrainsFilter === 'yes';
        if (row.trains !== wantsTrains) {
          return false;
        }
      }

      if (state.providerRetainsPromptsFilter !== 'all') {
        const wantsRetainsPrompts = state.providerRetainsPromptsFilter === 'yes';
        if (row.retainsPrompts !== wantsRetainsPrompts) {
          return false;
        }
      }

      if (state.providerLocationsFilter.length > 0) {
        const matchesLocation =
          (row.headquarters &&
            state.providerLocationsFilter.includes(getCountryDisplayName(row.headquarters))) ||
          row.datacenters?.some(dc =>
            state.providerLocationsFilter.includes(getCountryDisplayName(dc))
          );
        if (!matchesLocation) {
          return false;
        }
      }

      if (!normalizedSearch) {
        return true;
      }

      if (row.providerDisplayName.toLowerCase().includes(normalizedSearch)) {
        return true;
      }

      if (row.providerSlug.toLowerCase().includes(normalizedSearch)) {
        return true;
      }

      return false;
    });
  }, [
    enabledProviderSlugs,
    state.enabledProvidersOnly,
    state.providerLocationsFilter,
    state.providerRetainsPromptsFilter,
    providerRows,
    state.providerSearch,
    state.providerTrainsFilter,
  ]);

  const infoProvider = useMemo((): ProviderRow | null => {
    if (!state.infoProviderSlug) return null;
    const row = providerRows.find(r => r.providerSlug === state.infoProviderSlug);
    return row ?? null;
  }, [providerRows, state.infoProviderSlug]);

  const infoProviderModels = useMemo((): ProviderModelRow[] => {
    if (!infoProvider) return [];
    const provider = openRouterProviders.find(p => p.slug === infoProvider.providerSlug);
    if (!provider) return [];

    const rows: ProviderModelRow[] = [];
    for (const model of provider.models) {
      if (!model.endpoint) continue;
      const normalizedModelId = normalizeModelId(model.slug);
      const sourceIndex = rows.length;
      rows.push({
        modelId: normalizedModelId,
        modelName: model.name,
        preferredIndex: preferredIndexByModelId.get(normalizedModelId),
        sourceIndex,
        promptPrice: model.endpoint.pricing.prompt,
        completionPrice: model.endpoint.pricing.completion,
      });
    }

    rows.sort(compareRecommendedThenSourceIndex);

    return rows;
  }, [infoProvider, openRouterProviders, preferredIndexByModelId]);

  const infoProviderAllowsAllModels = useMemo(() => {
    if (!infoProvider) return false;
    if (state.status !== 'ready') return false;
    if (state.draftModelAllowList.length === 0) return false;
    return state.draftModelAllowList.includes(`${infoProvider.providerSlug}/*`);
  }, [infoProvider, state]);

  // NOTE: returns must happen after all hooks above, otherwise React will error
  // with "Rendered more hooks than during the previous render" as data loads.
  if (!organizationData) {
    return null;
  }

  if (organizationData.plan !== 'enterprise') {
    return (
      <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
        <div className="flex w-full flex-col gap-y-8">
          <OrganizationPageHeader
            organizationId={organizationId}
            title="Providers & Models"
            showBackButton={false}
          />
          <EnterpriseOnlyMessage />
        </div>
      </OrganizationContextProvider>
    );
  }

  const providerTrainsFilter: ProviderPolicyFilter = state.providerTrainsFilter;
  const providerRetainsPromptsFilter: ProviderPolicyFilter = state.providerRetainsPromptsFilter;

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-8">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Providers & Models"
          showBackButton={false}
        />

        <Tabs defaultValue="models">
          <TabsList className="w-fit">
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="mt-6">
            <ModelsTab
              isLoading={isLoading}
              canEdit={canEdit}
              search={state.modelSearch}
              selectedOnly={state.modelSelectedOnly}
              onSearchChange={actions.setModelSearch}
              onSelectedOnlyChange={actions.setModelSelectedOnly}
              allowedModelIds={allowedModelIds}
              enabledProviderSlugs={enabledProviderSlugs}
              filteredModelRows={filteredModelRows}
              onToggleModelAllowed={handleToggleModelAllowed}
              onOpenModelDetails={actions.setInfoModelId}
            />
          </TabsContent>

          <TabsContent value="providers" className="mt-6">
            <ProvidersTab
              isLoading={isProvidersLoading}
              canEdit={canEdit}
              search={state.providerSearch}
              enabledOnly={state.enabledProvidersOnly}
              providerTrainsFilter={providerTrainsFilter}
              providerRetainsPromptsFilter={providerRetainsPromptsFilter}
              providerLocationsFilter={state.providerLocationsFilter}
              providerLocationOptions={providerLocationOptions}
              filteredProviderRows={filteredProviderRows}
              enabledProviderSlugs={enabledProviderSlugs}
              enabledModelCountByProviderSlug={enabledModelCountByProviderSlug}
              onSearchChange={actions.setProviderSearch}
              onEnabledOnlyChange={actions.setEnabledProvidersOnly}
              onProviderTrainsFilterChange={actions.setProviderTrainsFilter}
              onProviderRetainsPromptsFilterChange={actions.setProviderRetainsPromptsFilter}
              onProviderLocationsFilterChange={actions.setProviderLocationsFilter}
              onToggleProviderEnabled={handleToggleProviderEnabled}
              onOpenProviderDetails={actions.setInfoProviderSlug}
            />
          </TabsContent>
        </Tabs>

        <ModelDetailsDialog
          open={state.infoModelId !== null}
          canEdit={canEdit}
          infoModel={infoModel}
          infoBaseModel={
            infoBaseModel
              ? {
                  description: infoBaseModel.description,
                  context_length: infoBaseModel.context_length,
                  author: infoBaseModel.author,
                  input_modalities: infoBaseModel.input_modalities,
                  output_modalities: infoBaseModel.output_modalities,
                }
              : null
          }
          offerings={infoOfferings}
          allowedModelIds={allowedModelIds}
          enabledProviderSlugs={enabledProviderSlugs}
          formatPriceCompact={formatPriceCompact}
          onToggleModelAllowed={handleToggleModelAllowed}
          onToggleProviderEnabled={handleToggleProviderEnabled}
          onClose={() => actions.setInfoModelId(null)}
        />

        <ProviderDetailsDialog
          open={state.infoProviderSlug !== null}
          canEdit={canEdit}
          infoProvider={infoProvider}
          enabledProviderSlugs={enabledProviderSlugs}
          draftModelAllowListLength={
            state.status === 'ready' ? state.draftModelAllowList.length : 0
          }
          infoProviderAllowsAllModels={infoProviderAllowsAllModels}
          infoProviderModels={infoProviderModels}
          allowedModelIds={allowedModelIds}
          formatPriceCompact={formatPriceCompact}
          onToggleProviderEnabled={handleToggleProviderEnabled}
          onToggleAllowFutureModelsForProvider={handleToggleAllowFutureModelsForProvider}
          onToggleModelAllowed={handleToggleModelAllowed}
          onClose={() => actions.setInfoProviderSlug(null)}
        />

        <ModelSelectionStatusBar
          isVisible={hasUnsavedChanges}
          selectedProvidersCount={enabledProviderSlugs.size}
          selectedModelsCount={allowedModelIds.size}
          onSave={handleSaveChanges}
          onCancel={handleCancelChanges}
        />
      </div>
    </OrganizationContextProvider>
  );
}
