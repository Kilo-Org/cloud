'use client';

import type { OrganizationGroupModelAccessPolicy } from '@/lib/organizations/group-policies/organization-group-policies';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ModelsTab } from '@/components/organizations/providers-and-models/ModelsTab';
import { ProvidersTab } from '@/components/organizations/providers-and-models/ProvidersTab';
import {
  buildModelProvidersIndex,
  sortUniqueStrings,
} from '@/components/organizations/providers-and-models/allowLists.domain';
import type {
  ModelRow,
  ProviderRow,
} from '@/components/organizations/providers-and-models/providersAndModels.types';
import { normalizeProviderIconUrl } from '@/components/organizations/providers-and-models/providerIconUrl';
import type { ProviderPolicyFilter } from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';
import type { OrganizationGroupPolicyEditorProps } from '@/components/organizations/groups/policies/types';
import { PolicyEditorFooter } from '@/components/organizations/groups/policies/PolicyEditorFooter';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { useTRPC } from '@/lib/trpc/utils';

type Mode = OrganizationGroupModelAccessPolicy['data']['mode'];

export function ModelAccessPolicyEditor({
  organizationId,
  policy,
  isSaving,
  onSave,
  onCancel,
  onDelete,
  isDeleting,
}: OrganizationGroupPolicyEditorProps<'model_access'>) {
  const trpc = useTRPC();
  const editorDataQuery = useQuery(
    trpc.organizations.groups.getPolicyEditorData.queryOptions({
      organizationId,
      policyType: 'model_access',
    })
  );
  const editorData =
    editorDataQuery.data?.policyType === 'model_access' ? editorDataQuery.data : undefined;
  const providers = useMemo(() => editorData?.catalog.providers ?? [], [editorData]);
  const models = useMemo(() => {
    const modelsBySlug = new Map<string, (typeof providers)[number]['models'][number]>();
    providers.forEach(provider =>
      provider.models.forEach(model => {
        if (model.endpoint && !modelsBySlug.has(model.slug)) modelsBySlug.set(model.slug, model);
      })
    );
    return [...modelsBySlug.values()];
  }, [providers]);
  const [mode, setMode] = useState<Mode>(policy.data.mode);
  const [modelIds, setModelIds] = useState<string[]>(
    policy.data.mode === 'selected' ? policy.data.model_allow_list : []
  );
  const [providerSlugs, setProviderSlugs] = useState<string[]>(
    policy.data.mode === 'selected' ? policy.data.provider_allow_list : []
  );
  const [modelSearch, setModelSearch] = useState('');
  const [selectedModelsOnly, setSelectedModelsOnly] = useState(false);
  const [providerSearch, setProviderSearch] = useState('');
  const [selectedProvidersOnly, setSelectedProvidersOnly] = useState(false);
  const [trainsFilter, setTrainsFilter] = useState<ProviderPolicyFilter>('all');
  const [retainsFilter, setRetainsFilter] = useState<ProviderPolicyFilter>('all');
  const [locations, setLocations] = useState<string[]>([]);

  const selectedModels = useMemo(() => new Set(modelIds.map(normalizeModelId)), [modelIds]);
  const selectedProviders = useMemo(() => new Set(providerSlugs), [providerSlugs]);
  const deniedModels = useMemo(
    () => new Set((editorData?.modelDenyList ?? []).map(normalizeModelId)),
    [editorData]
  );
  const providerCeiling = editorData?.providerAllowList;
  const providerCeilingSet = useMemo(
    () => (providerCeiling ? new Set(providerCeiling) : null),
    [providerCeiling]
  );
  const providerIndex = useMemo(() => buildModelProvidersIndex(providers), [providers]);

  const modelRows = useMemo((): ModelRow[] => {
    return models
      .map((model, sourceIndex) => {
        const modelId = normalizeModelId(model.slug);
        const routes = [...(providerIndex.get(modelId) ?? [])];
        const eligibleRoutes = providerCeilingSet
          ? routes.filter(route => providerCeilingSet.has(route))
          : routes;
        const unavailableReason = deniedModels.has(modelId)
          ? 'Unavailable under organization model settings'
          : eligibleRoutes.length === 0
            ? 'No route is available under organization provider settings'
            : undefined;
        return {
          modelId,
          modelName: model.name,
          providerSlugs: eligibleRoutes,
          preferredIndex: undefined,
          sourceIndex,
          unavailableReason,
        };
      })
      .filter(row => selectedModels.has(row.modelId) || !row.unavailableReason);
  }, [deniedModels, models, providerCeilingSet, providerIndex, selectedModels]);

  const filteredModels = useMemo(() => {
    const search = modelSearch.trim().toLowerCase();
    return modelRows.filter(row => {
      if (selectedModelsOnly && !selectedModels.has(row.modelId)) return false;
      return (
        !search ||
        row.modelName.toLowerCase().includes(search) ||
        row.modelId.toLowerCase().includes(search) ||
        row.providerSlugs.some(slug => slug.toLowerCase().includes(search))
      );
    });
  }, [modelRows, modelSearch, selectedModels, selectedModelsOnly]);

  const providerRows = useMemo((): ProviderRow[] => {
    return providers
      .filter(
        provider =>
          selectedProviders.has(provider.slug) ||
          !providerCeilingSet ||
          providerCeilingSet.has(provider.slug)
      )
      .map(provider => ({
        providerSlug: provider.slug,
        providerDisplayName: provider.displayName,
        providerIconUrl: provider.icon?.url ? normalizeProviderIconUrl(provider.icon.url) : null,
        modelCount: provider.models.filter(model => model.endpoint).length,
        trains: provider.dataPolicy.training,
        retainsPrompts: provider.dataPolicy.retainsPrompts,
        headquarters: provider.headquarters,
        datacenters: provider.datacenters,
        unavailableReason:
          providerCeilingSet && !providerCeilingSet.has(provider.slug)
            ? 'Unavailable under organization provider settings'
            : undefined,
      }))
      .filter(provider => provider.modelCount > 0)
      .sort((a, b) => a.providerDisplayName.localeCompare(b.providerDisplayName));
  }, [providerCeilingSet, providers, selectedProviders]);

  const locationOptions = useMemo(() => {
    const values = new Set<string>();
    providerRows.forEach(row => {
      if (row.headquarters) values.add(row.headquarters);
      row.datacenters?.forEach(location => values.add(location));
    });
    return [...values].sort();
  }, [providerRows]);

  const filteredProviders = useMemo(() => {
    const search = providerSearch.trim().toLowerCase();
    return providerRows.filter(row => {
      if (selectedProvidersOnly && !selectedProviders.has(row.providerSlug)) return false;
      if (trainsFilter !== 'all' && row.trains !== (trainsFilter === 'yes')) return false;
      if (retainsFilter !== 'all' && row.retainsPrompts !== (retainsFilter === 'yes')) return false;
      if (
        locations.length > 0 &&
        ![row.headquarters, ...(row.datacenters ?? [])].some(
          location => location && locations.includes(location)
        )
      )
        return false;
      return (
        !search ||
        row.providerDisplayName.toLowerCase().includes(search) ||
        row.providerSlug.toLowerCase().includes(search)
      );
    });
  }, [
    locations,
    providerRows,
    providerSearch,
    retainsFilter,
    selectedProviders,
    selectedProvidersOnly,
    trainsFilter,
  ]);

  const selectedModelCountByProvider = useMemo(() => {
    const counts = new Map<string, number>();
    providerRows.forEach(provider => {
      const models = providers.find(item => item.slug === provider.providerSlug)?.models ?? [];
      counts.set(
        provider.providerSlug,
        models.filter(model => model.endpoint && selectedModels.has(normalizeModelId(model.slug)))
          .length
      );
    });
    return counts;
  }, [providerRows, providers, selectedModels]);

  function save() {
    onSave(
      mode === 'selected'
        ? {
            type: 'model_access',
            data: {
              mode,
              model_allow_list: sortUniqueStrings([...selectedModels]),
              provider_allow_list: sortUniqueStrings([...selectedProviders]),
            },
          }
        : { type: 'model_access', data: { mode } }
    );
  }

  if (editorDataQuery.isLoading) {
    return <p className="type-body text-muted-foreground p-5">Loading model catalog...</p>;
  }
  if (editorDataQuery.isError || !editorData) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        {editorDataQuery.error?.message ?? 'Unable to load the model catalog.'}
      </p>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 content-start gap-4 p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="model-access-mode">Access mode</Label>
          <Select value={mode} onValueChange={value => setMode(value as Mode)}>
            <SelectTrigger id="model-access-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              <SelectItem value="all">All organization-approved models</SelectItem>
              <SelectItem value="none">No model access</SelectItem>
              <SelectItem value="selected">Selected models and providers</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === 'selected' && (
          <Tabs defaultValue="models">
            <TabsList>
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
            </TabsList>
            <TabsContent value="models" className="mt-4">
              <ModelsTab
                scope="group"
                showDetails={false}
                isLoading={false}
                canEdit
                search={modelSearch}
                selectedOnly={selectedModelsOnly}
                onSearchChange={setModelSearch}
                onSelectedOnlyChange={setSelectedModelsOnly}
                allowedModelIds={selectedModels}
                enabledProviderSlugs={selectedProviders}
                filteredModelRows={filteredModels}
                onToggleModelAllowed={(modelId, selected) =>
                  setModelIds(current =>
                    selected
                      ? sortUniqueStrings([...current, modelId])
                      : current.filter(value => value !== modelId)
                  )
                }
                onOpenModelDetails={() => undefined}
              />
            </TabsContent>
            <TabsContent value="providers" className="mt-4">
              <ProvidersTab
                scope="group"
                showDetails={false}
                isLoading={false}
                canEdit
                search={providerSearch}
                enabledOnly={selectedProvidersOnly}
                providerTrainsFilter={trainsFilter}
                providerRetainsPromptsFilter={retainsFilter}
                providerLocationsFilter={locations}
                providerLocationOptions={locationOptions}
                filteredProviderRows={filteredProviders}
                enabledProviderSlugs={selectedProviders}
                enabledModelCountByProviderSlug={selectedModelCountByProvider}
                onSearchChange={setProviderSearch}
                onEnabledOnlyChange={setSelectedProvidersOnly}
                onProviderTrainsFilterChange={setTrainsFilter}
                onProviderRetainsPromptsFilterChange={setRetainsFilter}
                onProviderLocationsFilterChange={setLocations}
                onToggleProviderEnabled={(providerSlug, selected) =>
                  setProviderSlugs(current =>
                    selected
                      ? sortUniqueStrings([...current, providerSlug])
                      : current.filter(value => value !== providerSlug)
                  )
                }
                onOpenProviderDetails={() => undefined}
              />
            </TabsContent>
          </Tabs>
        )}
        <p className="type-label text-muted-foreground">
          Direct BYOK models remain available organization-wide. Custom LLM access is configured
          separately.
        </p>
      </div>
      <PolicyEditorFooter
        isSaving={isSaving}
        onSave={save}
        onCancel={onCancel}
        onDelete={onDelete}
        isDeleting={isDeleting}
      />
    </div>
  );
}
