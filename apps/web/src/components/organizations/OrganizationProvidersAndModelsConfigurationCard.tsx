'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { Settings } from 'lucide-react';
import { CardLinkFooter } from '@/components/ui/card.client';
import { ChevronRight } from 'lucide-react';
import { CondensedProviderAndModelsList } from '@/components/models/CondensedProviderAndModelsList';
import { DefaultModelDialog } from './providers-and-models/DefaultModelDialog';
import { AvailableModelsDialog } from './providers-and-models/AvailableModelsDialog';
import { useOrganizationConfiguration } from './providers-and-models/useOrganizationConfiguration';
import { useOpenRouterModelsAndProviders } from '@/app/api/openrouter/hooks';
import type { ProviderSelection } from '@/components/models/util';
import { normalizeModelId } from '@/lib/model-utils';

type OrganizationProvidersAndModelsConfigurationCardProps = {
  organizationId: string;
  readonly: boolean;
};

type ProviderForSummaryCard = {
  slug: string;
  models: Array<{
    slug: string;
    endpoint?: unknown;
  }>;
};

export function computeProviderSelectionsForSummaryCard(params: {
  openRouterProviders: ProviderForSummaryCard[];
  providerDenyList: string[];
  modelDenyList: string[];
}): ProviderSelection[] | null {
  const { openRouterProviders, providerDenyList, modelDenyList } = params;
  // If both deny lists are empty, there are no restrictions
  if (providerDenyList.length === 0 && modelDenyList.length === 0) {
    return null;
  }

  const providerDenySet = new Set(providerDenyList);
  const modelDenySet = new Set(modelDenyList.map(id => normalizeModelId(id)));

  const selections: ProviderSelection[] = [];

  for (const provider of openRouterProviders) {
    if (providerDenySet.has(provider.slug)) continue;

    const availableModels = provider.models
      .filter(model => model.endpoint && !modelDenySet.has(normalizeModelId(model.slug)))
      .map(model => model.slug);

    if (availableModels.length > 0) {
      selections.push({
        slug: provider.slug,
        models: availableModels,
      });
    }
  }

  // Empty array means restrictions exist but nothing survived — distinct from null ("no restrictions")
  return selections.length > 0 ? selections : [];
}

export function OrganizationProvidersAndModelsConfigurationCard({
  organizationId,
  readonly,
}: OrganizationProvidersAndModelsConfigurationCardProps) {
  const [isDefaultModelDialogOpen, setIsDefaultModelDialogOpen] = useState(false);
  const [isAvailableModelsDialogOpen, setIsAvailableModelsDialogOpen] = useState(false);
  const { isLoading, organizationData, configurationData } =
    useOrganizationConfiguration(organizationId);
  const { providers: openRouterProviders } = useOpenRouterModelsAndProviders();

  // Convert configuration data to ProviderSelection[] format
  const providerSelections = useMemo((): ProviderSelection[] | null => {
    if (!configurationData || !organizationData || !openRouterProviders) {
      return null;
    }

    const settings = organizationData.settings;
    const providerDenyList = settings?.provider_deny_list ?? [];
    const modelDenyList = settings?.model_deny_list ?? [];

    return computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerDenyList,
      modelDenyList,
    });
  }, [configurationData, organizationData, openRouterProviders]);

  if (isLoading) {
    return <LoadingCard title="" description="Loading providers and models..." rowCount={3} />;
  }

  if (!organizationData) {
    return (
      <ErrorCard
        title="Providers and models"
        description="Error loading organization data"
        error={new Error('Organization data not found')}
        onRetry={() => {}}
      />
    );
  }

  if (!configurationData) {
    return (
      <ErrorCard
        title="Providers and models"
        description="Error loading configuration data"
        error={new Error('Configuration data not available')}
        onRetry={() => {}}
      />
    );
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="mb-2">
        <CardTitle>
          <Settings className="mr-2 inline h-5 w-5" />
          Providers and models
        </CardTitle>
      </CardHeader>
      <CardDescription className="mb-6 px-6">
        {providerSelections === null
          ? 'All providers and models'
          : (() => {
              const providerCount = providerSelections.length;
              const modelCount = providerSelections.reduce(
                (total, provider) => total + provider.models.length,
                0
              );
              const providerText = providerCount === 1 ? 'provider' : 'providers';
              const modelText = modelCount === 1 ? 'model' : 'models';
              return (
                <>
                  {providerCount} {providerText} and{' '}
                  <button
                    onClick={() => setIsAvailableModelsDialogOpen(true)}
                    className="cursor-pointer text-yellow-400 underline hover:text-yellow-300"
                  >
                    {modelCount} {modelText}
                  </button>{' '}
                  selected
                </>
              );
            })()}
      </CardDescription>
      <CardContent className="flex-1 overflow-hidden">
        <div className="h-72 overflow-y-auto">
          <CondensedProviderAndModelsList
            selections={providerSelections}
            defaultModel={organizationData.settings?.default_model}
            onDefaultModelClick={() => {
              setIsDefaultModelDialogOpen(true);
            }}
            readonly={readonly}
          />
        </div>
        <CardLinkFooter
          href={`/organizations/${organizationId}/providers-and-models`}
          className="flex items-center gap-2"
        >
          {readonly ? 'View ' : 'Configure '} providers and models
          <span className="ml-auto">
            <ChevronRight className="h-4 w-4" />
          </span>
        </CardLinkFooter>
      </CardContent>

      <DefaultModelDialog
        open={isDefaultModelDialogOpen}
        onOpenChange={setIsDefaultModelDialogOpen}
        organizationId={organizationId}
        organizationSettings={organizationData?.settings}
        currentDefaultModel={organizationData?.settings?.default_model}
      />

      <AvailableModelsDialog
        open={isAvailableModelsDialogOpen}
        onOpenChange={setIsAvailableModelsDialogOpen}
        organizationId={organizationId}
      />
    </Card>
  );
}
