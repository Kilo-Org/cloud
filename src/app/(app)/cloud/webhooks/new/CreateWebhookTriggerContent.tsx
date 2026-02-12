'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { getWebhookRoutes } from '@/lib/webhook-routes';

import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TriggerForm, type TriggerFormData } from '@/components/webhook-triggers/TriggerForm';
import type { GitHubRepository } from '@/components/webhook-triggers/types';
import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ArrowLeft, Webhook, AlertCircle } from 'lucide-react';

type CreateWebhookTriggerContentProps = {
  organizationId?: string;
};

export function CreateWebhookTriggerContent({ organizationId }: CreateWebhookTriggerContentProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Build URLs based on context
  const routes = getWebhookRoutes(organizationId);

  const integrationsPath = organizationId
    ? `/organizations/${organizationId}/integrations`
    : '/integrations';

  // Fetch eligibility to check if user can create webhook triggers (requires credits)

  // Fetch GitHub repositories
  const {
    data: githubRepoData,
    isLoading: isLoadingRepos,
    error: repoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgent.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgent.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Check if GitHub integration is missing
  const isGitHubIntegrationMissing =
    !isLoadingRepos && githubRepoData?.integrationInstalled === false;

  // Fetch models
  const { data: modelsData, isLoading: isLoadingModels } = useModelSelectorList(organizationId);

  // Transform repositories to RepositoryOption format
  const repositories = useMemo<RepositoryOption[]>(() => {
    const repos = (githubRepoData?.repositories || []) as GitHubRepository[];
    return repos.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
    }));
  }, [githubRepoData?.repositories]);

  // Transform models to ModelOption format
  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData?.data]
  );

  // Create mutation
  const { mutateAsync: createTrigger, isPending: isCreatePending } = useMutation(
    trpc.webhookTriggers.create.mutationOptions({
      onSuccess: data => {
        // Show success toast with the webhook URL
        toast.success('Webhook trigger created successfully', {
          description: `Webhook URL: ${data.inboundUrl}`,
          duration: 5000,
        });

        // Invalidate the triggers list cache
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });

        // Navigate to the trigger detail page (context-aware)
        void router.push(routes.edit(data.triggerId));
      },
      onError: err => {
        toast.error(`Failed to create trigger: ${err.message}`);
      },
    })
  );

  // Handle form submission
  const handleSubmit = useCallback(
    async (formData: TriggerFormData) => {
      await createTrigger({
        triggerId: formData.triggerId,
        githubRepo: formData.githubRepo,
        mode: formData.mode,
        model: formData.model,
        promptTemplate: formData.promptTemplate,
        profileId: formData.profileId,
        autoCommit: formData.autoCommit,
        condenseOnComplete: formData.condenseOnComplete,
        webhookAuth: formData.webhookAuth.enabled
          ? {
              header: formData.webhookAuth.header ?? '',
              secret: formData.webhookAuth.secret ?? '',
            }
          : undefined,
        organizationId: organizationId ?? undefined,
      });
    },
    [createTrigger, organizationId]
  );

  // Handle cancel
  const handleCancel = useCallback(() => {
    router.push(routes.list);
  }, [router, routes.list]);

  // Common header component
  const headerContent = (
    <div className="mb-6">
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={routes.list}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Webhook Triggers
          </Link>
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <Webhook className="h-8 w-8" />
        <h1 className="text-3xl font-bold">Create Webhook Trigger</h1>
      </div>
      <p className="text-muted-foreground mt-2">
        Configure a new webhook trigger to automatically start cloud agent sessions.
      </p>
    </div>
  );

  // If GitHub integration is missing, show setup prompt
  if (isGitHubIntegrationMissing) {
    const integrationMessage =
      githubRepoData?.errorMessage || 'Connect a GitHub integration to create webhook triggers.';

    return (
      <>
        {headerContent}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-400" />
              Connect GitHub to create webhook triggers
            </CardTitle>
            <CardDescription>{integrationMessage}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-gray-300">
              Webhook triggers require access to your GitHub repositories. Install the GitHub
              integration to continue.
            </p>
            <div className="flex flex-wrap gap-3">
              <LinkButton href={integrationsPath} variant="primary" size="md">
                Open integrations
              </LinkButton>
              <Button variant="outline" onClick={() => router.refresh()}>
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {headerContent}

      {/* Form */}
      <TriggerForm
        mode="create"
        organizationId={organizationId}
        repositories={repositories}
        isLoadingRepositories={isLoadingRepos}
        repositoriesError={repoError?.message}
        models={modelOptions}
        isLoadingModels={isLoadingModels}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isLoading={isCreatePending}
      />
    </>
  );
}
