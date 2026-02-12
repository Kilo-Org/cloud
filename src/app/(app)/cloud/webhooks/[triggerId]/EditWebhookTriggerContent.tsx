'use client';

import { use, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { getWebhookRoutes } from '@/lib/webhook-routes';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TriggerForm, type TriggerFormData } from '@/components/webhook-triggers/TriggerForm';
import type { GitHubRepository } from '@/components/webhook-triggers/types';
import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import type { AgentMode } from '@/components/cloud-agent/types';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ArrowLeft, Webhook, ExternalLink, RefreshCw } from 'lucide-react';

type EditWebhookTriggerContentProps = {
  params: Promise<{ triggerId: string }>;
  organizationId?: string;
};

export function EditWebhookTriggerContent({
  params,
  organizationId,
}: EditWebhookTriggerContentProps) {
  const { triggerId } = use(params);
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Build URLs based on context
  const routes = getWebhookRoutes(organizationId);

  // Fetch trigger configuration
  const {
    data: triggerData,
    isLoading: isLoadingTrigger,
    error: triggerError,
    refetch: refetchTrigger,
  } = useQuery(
    trpc.webhookTriggers.get.queryOptions({
      triggerId,
      organizationId: organizationId ?? undefined,
    })
  );

  // Fetch GitHub repositories (use org-scoped query when in org context)
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

  // Transform trigger data to form initial data
  const initialData = useMemo(() => {
    if (!triggerData) return undefined;
    return {
      triggerId: triggerData.triggerId,
      githubRepo: triggerData.githubRepo,
      mode: triggerData.mode as AgentMode,
      model: triggerData.model,
      promptTemplate: triggerData.promptTemplate,
      profileId: triggerData.profileId ?? undefined,
      autoCommit: triggerData.autoCommit ?? undefined,
      condenseOnComplete: triggerData.condenseOnComplete ?? undefined,
      isActive: triggerData.isActive,
      webhookAuthHeader: triggerData.webhookAuthHeader ?? undefined,
      webhookAuthConfigured: triggerData.webhookAuthConfigured,
    };
  }, [triggerData]);

  // Update mutation
  const { mutateAsync: updateTrigger, isPending: isUpdatePending } = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onSuccess: () => {
        toast.success('Webhook trigger updated successfully');
        // Invalidate the triggers list cache
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
        // Refetch current trigger data
        void refetchTrigger();
      },
      onError: err => {
        toast.error(`Failed to update trigger: ${err.message}`);
      },
    })
  );

  // Delete mutation
  const { mutateAsync: deleteTriggerAsync, isPending: isDeletePending } = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Webhook trigger deleted successfully');
        // Invalidate the triggers list cache
        void queryClient.invalidateQueries({ queryKey: trpc.webhookTriggers.list.queryKey() });
        // Navigate back to list (context-aware)
        void router.push(routes.list);
      },
      onError: err => {
        toast.error(`Failed to delete trigger: ${err.message}`);
      },
    })
  );

  // Handle form submission
  const handleSubmit = useCallback(
    async (formData: TriggerFormData) => {
      await updateTrigger({
        triggerId: formData.triggerId,
        mode: formData.mode,
        model: formData.model,
        promptTemplate: formData.promptTemplate,
        profileId: formData.profileId,
        autoCommit: formData.autoCommit ?? null,
        condenseOnComplete: formData.condenseOnComplete ?? null,
        isActive: formData.isActive,
        webhookAuth: formData.webhookAuth.enabled
          ? {
              header: formData.webhookAuth.header,
              ...(formData.webhookAuth.secret ? { secret: formData.webhookAuth.secret } : {}),
            }
          : { header: null, secret: null },
        organizationId: organizationId ?? undefined,
      });
    },
    [updateTrigger, organizationId]
  );

  // Handle cancel
  const handleCancel = useCallback(() => {
    router.push(routes.list);
  }, [router, routes.list]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    await deleteTriggerAsync({
      triggerId,
      organizationId: organizationId ?? undefined,
    });
  }, [deleteTriggerAsync, triggerId, organizationId]);

  // Loading state
  if (isLoadingTrigger) {
    return (
      <>
        <div className="mb-6">
          <div className="mb-4">
            <Skeleton className="h-8 w-48" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-9 w-64" />
          </div>
          <Skeleton className="mt-2 h-5 w-96" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </>
    );
  }

  // Error/404 state
  if (triggerError) {
    const isNotFound = triggerError.message.includes('not found');
    return (
      <>
        <div className="mb-6">
          <div className="mb-4">
            <Button variant="ghost" size="sm" asChild>
              <Link href={routes.list}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Webhook Triggers
              </Link>
            </Button>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              {isNotFound ? 'Trigger Not Found' : 'Error Loading Trigger'}
            </CardTitle>
            <CardDescription>
              {isNotFound
                ? `The webhook trigger "${triggerId}" does not exist or you don't have access to it.`
                : `An error occurred while loading the trigger: ${triggerError.message}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <Link href={routes.list}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to List
                </Link>
              </Button>
              {!isNotFound && (
                <Button variant="outline" onClick={() => refetchTrigger()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {/* Header */}
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
          <h1 className="text-3xl font-bold">Edit: {triggerId}</h1>
        </div>
        <p className="text-muted-foreground mt-2">
          Update the configuration for this webhook trigger.
        </p>

        {/* Link to view captured requests */}
        <div className="mt-4">
          <Button variant="outline" size="sm" asChild>
            <Link href={routes.requests(triggerId)}>
              <ExternalLink className="mr-2 h-4 w-4" />
              View Captured Requests
            </Link>
          </Button>
        </div>
      </div>

      {/* Form */}
      <TriggerForm
        mode="edit"
        organizationId={organizationId}
        initialData={initialData}
        repositories={repositories}
        isLoadingRepositories={isLoadingRepos}
        repositoriesError={repoError?.message}
        models={modelOptions}
        isLoadingModels={isLoadingModels}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        onDelete={handleDelete}
        isLoading={isUpdatePending || isDeletePending}
        inboundUrl={triggerData?.inboundUrl}
      />
    </>
  );
}
