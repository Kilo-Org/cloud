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
import { useOpenRouterModelsAndProviders } from '@/lib/hooks/use-openrouter-models';
import { useOrganizationAvailableModels } from '@/app/api/organizations/hooks';
import type { ProviderSelection } from '@/components/models/util';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';

type OrganizationProvidersAndModelsConfigurationCardProps = {
  organizationId: string;
  readonly: boolean;
};

type ProviderForSummaryCard = {
  slug: string;
  models: Array<{
    slug: string;
    endpoint?: unknown | null;
  }>;
};

/**
 * Groups the organization's available models by the enabled providers that
 * serve them. Availability comes from `listAvailableModels`, not from the
 * provider snapshot: the snapshot also lists models Kilo does not offer, such
 * as speech, video, and reranking models.
 */
export function computeProviderSelectionsForSummaryCard(params: {
  openRouterProviders: ProviderForSummaryCard[];
  providerAllowList: string[] | undefined;
  modelDenyList: string[] | undefined;
  availableModelIds: ReadonlyArray<string>;
}): ProviderSelection[] | null {
  const { openRouterProviders, providerAllowList, modelDenyList, availableModelIds } = params;
  if (providerAllowList === undefined && (!modelDenyList || modelDenyList.length === 0)) {
    return null;
  }

  const providerAllowSet = providerAllowList ? new Set(providerAllowList) : null;
  const availableModelIdSet = new Set(availableModelIds.map(id => normalizeModelId(id)));

  const selections: ProviderSelection[] = [];

  for (const provider of openRouterProviders) {
    if (providerAllowSet && !providerAllowSet.has(provider.slug)) continue;

    const availableModels = provider.models
      .filter(model => model.endpoint && availableModelIdSet.has(normalizeModelId(model.slug)))
      .map(model => model.slug);

    if (availableModels.length > 0) {
      selections.push({
        slug: provider.slug,
        models: availableModels,
      });
    }
  }

  return selections;
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
  const availableModels = useOrganizationAvailableModels(organizationId);

  const providerSelections = useMemo((): ProviderSelection[] | null => {
    if (!configurationData || !organizationData) {
      return null;
    }

    const settings = organizationData.settings;

    return computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: settings?.provider_allow_list,
      modelDenyList: settings?.model_deny_list,
      availableModelIds: availableModels.data?.data.map(model => model.id) ?? [],
    });
  }, [configurationData, organizationData, openRouterProviders, availableModels.data]);

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

  const modelCount = availableModels.data?.data.length;

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
          : modelCount === undefined
            ? availableModels.isError
              ? 'Could not load allowed models'
              : 'Loading allowed models…'
            : (() => {
                const providerCount = providerSelections.length;
                const providerText = providerCount === 1 ? 'provider' : 'providers';
                const modelText = modelCount === 1 ? 'model' : 'models';
                return (
                  <>
                    {providerCount} {providerText} and{' '}
                    <button
                      onClick={() => setIsAvailableModelsDialogOpen(true)}
                      className="cursor-pointer text-primary underline hover:text-primary-hover"
                    >
                      {modelCount} {modelText}
                    </button>{' '}
                    allowed
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
        organizationPlan={organizationData?.plan}
      />

      <AvailableModelsDialog
        open={isAvailableModelsDialogOpen}
        onOpenChange={setIsAvailableModelsDialogOpen}
        organizationId={organizationId}
      />
    </Card>
  );
}
