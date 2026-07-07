'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, Play, RefreshCw, Save, Settings2, ShieldCheck } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import {
  getAvailableThinkingEfforts,
  thinkingEffortLabel,
} from '@/lib/code-reviews/core/model-variants';
import { useTRPC } from '@/lib/trpc/utils';
import { RepositoryMultiSelect } from './RepositoryMultiSelect';
import { FOCUS_AREAS, REVIEW_STYLES } from './ReviewConfigForm';

type ReviewStyle = (typeof REVIEW_STYLES)[number]['value'];

type BitbucketReviewConfig = {
  reviewStyle: ReviewStyle;
  focusAreas: string[];
  customInstructions: string;
  modelSlug: string;
  thinkingEffort: string | null;
  selectedRepositoryIds: string[];
};

type BitbucketReviewConfigFormProps = {
  organizationId: string;
};

const DEFAULT_CONFIG: BitbucketReviewConfig = {
  reviewStyle: 'balanced',
  focusAreas: [],
  customInstructions: '',
  modelSlug: PRIMARY_DEFAULT_MODEL,
  thinkingEffort: null,
  selectedRepositoryIds: [],
};

function configFingerprint(config: BitbucketReviewConfig): string {
  return JSON.stringify({
    ...config,
    focusAreas: config.focusAreas.toSorted(),
    selectedRepositoryIds: config.selectedRepositoryIds.toSorted(),
  });
}

export function BitbucketReviewConfigForm({ organizationId }: BitbucketReviewConfigFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQuery = useQuery(
    trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
      organizationId,
      platform: 'bitbucket',
    })
  );
  const readinessQuery = useQuery(
    trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({ organizationId })
  );
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);
  const [draft, setDraft] = useState<BitbucketReviewConfig>(DEFAULT_CONFIG);
  const [baseline, setBaseline] = useState<BitbucketReviewConfig>(DEFAULT_CONFIG);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [manualReviewUrl, setManualReviewUrl] = useState('');
  const [manualReviewError, setManualReviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!configQuery.data) return;
    const nextConfig: BitbucketReviewConfig = {
      reviewStyle: configQuery.data.reviewStyle,
      focusAreas: configQuery.data.focusAreas,
      customInstructions: configQuery.data.customInstructions ?? '',
      modelSlug: configQuery.data.modelSlug,
      thinkingEffort: configQuery.data.thinkingEffort,
      selectedRepositoryIds: configQuery.data.selectedRepositoryIds.filter(
        (repositoryId): repositoryId is string => typeof repositoryId === 'string'
      ),
    };
    setDraft(nextConfig);
    setBaseline(nextConfig);
  }, [configQuery.data]);

  useEffect(() => {
    const repositoryCache = readinessQuery.data?.repositoryCache;
    if (!configQuery.data || repositoryCache?.status !== 'available') return;

    const cachedRepositoryIds = new Set(
      repositoryCache.repositories.map(repository => repository.id)
    );
    setDraft(current => {
      const selectedRepositoryIds = current.selectedRepositoryIds.filter(repositoryId =>
        cachedRepositoryIds.has(repositoryId)
      );
      return selectedRepositoryIds.length === current.selectedRepositoryIds.length
        ? current
        : { ...current, selectedRepositoryIds };
    });
  }, [configQuery.data, readinessQuery.data?.repositoryCache]);

  const availableThinkingEfforts = useMemo(
    () => getAvailableThinkingEfforts(draft.modelSlug),
    [draft.modelSlug]
  );

  useEffect(() => {
    if (draft.thinkingEffort && !availableThinkingEfforts.includes(draft.thinkingEffort)) {
      setDraft(current => ({ ...current, thinkingEffort: null }));
    }
  }, [availableThinkingEfforts, draft.thinkingEffort]);

  const invalidateBitbucketQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.reviewAgent.getBitbucketReadiness.queryKey({
          organizationId,
        }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.bitbucket.getStatus.queryKey({ organizationId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
          organizationId,
        }),
      }),
    ]);
  };

  const saveMutation = useMutation(
    trpc.organizations.reviewAgent.saveReviewConfig.mutationOptions({
      onSuccess: async () => {
        setMutationError(null);
        setValidationError(null);
        toast.success('Bitbucket Code Reviewer settings saved');
        await configQuery.refetch();
      },
      onError: error => {
        setMutationError(error.message);
      },
    })
  );

  const toggleMutation = useMutation(
    trpc.organizations.reviewAgent.toggleReviewAgent.mutationOptions({
      onSuccess: async data => {
        setMutationError(null);
        toast.success(
          data.isEnabled ? 'Bitbucket Code Reviewer enabled' : 'Bitbucket Code Reviewer disabled'
        );
        await Promise.all([configQuery.refetch(), invalidateBitbucketQueries()]);
      },
      onError: error => {
        setMutationError(error.message);
      },
    })
  );

  const refreshRepositoriesMutation = useMutation(
    trpc.organizations.bitbucket.refreshRepositories.mutationOptions({
      onSuccess: async result => {
        if (result.status !== 'available') {
          setMutationError(
            'Bitbucket repositories could not be refreshed. Verify the token and try again.'
          );
          return;
        }
        setMutationError(null);
        toast.success('Bitbucket repositories refreshed');
        await invalidateBitbucketQueries();
      },
      onError: error => {
        setMutationError(error.message);
      },
    })
  );

  const manualReviewMutation = useMutation(
    trpc.organizations.reviewAgent.triggerBitbucketCodeReview.mutationOptions({
      onSuccess: async result => {
        setManualReviewError(null);
        setManualReviewUrl('');
        toast.success(
          result.status === 'queued'
            ? 'Bitbucket code review queued'
            : 'Bitbucket code review already exists',
          {
            description:
              result.status === 'queued'
                ? 'The review will appear in Jobs.'
                : 'A review for that pull request head already exists.',
          }
        );
        await queryClient.invalidateQueries(trpc.codeReviews.listForOrganization.pathFilter());
      },
      onError: error => {
        setManualReviewError(error.message);
        toast.error('Failed to start Bitbucket code review', {
          description: error.message,
        });
      },
    })
  );

  if (configQuery.isLoading || readinessQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Review configuration</CardTitle>
          <CardDescription>Loading Bitbucket Code Reviewer settings...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (configQuery.error || readinessQuery.error || !readinessQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Code Reviewer settings are unavailable</AlertTitle>
        <AlertDescription>
          {configQuery.error?.message ??
            readinessQuery.error?.message ??
            'Refresh the page and try again.'}
        </AlertDescription>
      </Alert>
    );
  }

  const readiness = readinessQuery.data;
  const isEnabled = configQuery.data?.isEnabled ?? false;
  const isDirty = configFingerprint(draft) !== configFingerprint(baseline);
  const hasRepositories = draft.selectedRepositoryIds.length > 0;
  const canEnable = readiness.canManage && readiness.ready && hasRepositories && !isDirty;
  const repositoryCache = readiness.repositoryCache;
  const repositories = repositoryCache.repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
  }));

  let enableHint = 'Code Reviewer is ready to enable.';
  if (!readiness.canManage) {
    enableHint = 'An organization owner or billing manager can change this setting.';
  } else if (!readiness.ready) {
    enableHint = 'Replace the Workspace Access Token with the required Code Reviewer permissions.';
  } else if (!hasRepositories) {
    enableHint = 'Select at least one repository and save changes before enabling.';
  } else if (isDirty) {
    enableHint = 'Save changes before enabling Code Reviewer.';
  }

  const handleSave = () => {
    setMutationError(null);
    if (!hasRepositories) {
      setValidationError('Select at least one repository before saving changes.');
      return;
    }
    setValidationError(null);
    saveMutation.mutate({
      organizationId,
      platform: 'bitbucket',
      reviewStyle: draft.reviewStyle,
      focusAreas: draft.focusAreas,
      customInstructions: draft.customInstructions.trim() || undefined,
      modelSlug: draft.modelSlug,
      thinkingEffort: draft.thinkingEffort,
      gateThreshold: 'off',
      repositorySelectionMode: 'selected',
      selectedRepositoryIds: draft.selectedRepositoryIds,
      disableReviewMd: true,
    });
  };

  const handleToggle = (checked: boolean) => {
    setMutationError(null);
    toggleMutation.mutate({
      organizationId,
      platform: 'bitbucket',
      isEnabled: checked,
    });
  };

  const handleRefreshRepositories = () => {
    if (!readiness.integrationId) return;
    refreshRepositoriesMutation.mutate({
      organizationId,
      integrationId: readiness.integrationId,
    });
  };

  const handleManualReview = () => {
    const pullRequestUrl = manualReviewUrl.trim();
    if (!pullRequestUrl) {
      setManualReviewError('Enter a Bitbucket pull request URL.');
      return;
    }
    setManualReviewError(null);
    manualReviewMutation.mutate({
      organizationId,
      pullRequestUrl,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="size-5" />
          Review configuration
        </CardTitle>
        <CardDescription>
          Configure reviews for selected Bitbucket repositories. Settings can be saved while Code
          Reviewer is disabled.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={event => {
            event.preventDefault();
            handleSave();
          }}
        >
          <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <Label htmlFor="bitbucket-code-reviewer-enabled" className="type-body-lg font-medium">
                Enable Code Reviewer
              </Label>
              <p className="text-muted-foreground text-sm">
                {isEnabled ? 'New Bitbucket pull requests are reviewed automatically.' : enableHint}
              </p>
            </div>
            <Switch
              id="bitbucket-code-reviewer-enabled"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={
                toggleMutation.isPending || !readiness.canManage || (!isEnabled && !canEnable)
              }
              aria-describedby="bitbucket-code-reviewer-enable-hint"
            />
            <span id="bitbucket-code-reviewer-enable-hint" className="sr-only">
              {enableHint}
            </span>
          </div>

          {mutationError && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Bitbucket Code Reviewer could not be updated</AlertTitle>
              <AlertDescription>{mutationError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-6">
            <ModelCombobox
              label="AI model"
              models={modelOptions}
              value={draft.modelSlug}
              onValueChange={modelSlug => setDraft(current => ({ ...current, modelSlug }))}
              isLoading={isLoadingModels}
              helperText="Choose the model used for Bitbucket pull request reviews."
            />

            {availableThinkingEfforts.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="bitbucket-thinking-effort">Thinking effort</Label>
                <Select
                  value={draft.thinkingEffort ?? '__default__'}
                  onValueChange={value =>
                    setDraft(current => ({
                      ...current,
                      thinkingEffort: value === '__default__' ? null : value,
                    }))
                  }
                >
                  <SelectTrigger id="bitbucket-thinking-effort" className="h-11 w-full sm:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Default</SelectItem>
                    {availableThinkingEfforts.map(effort => (
                      <SelectItem key={effort} value={effort}>
                        {thinkingEffortLabel(effort)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-sm">
                  Configure the model&apos;s reasoning intensity.
                </p>
              </div>
            )}

            <div className="space-y-3 border-t border-border pt-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="space-y-1">
                  <Label>Repositories</Label>
                  <p className="text-muted-foreground text-sm">
                    Select the repositories that should trigger automatic reviews.
                  </p>
                  {repositoryCache.syncedAt && (
                    <p className="text-muted-foreground text-xs">
                      Last synced{' '}
                      {formatDistanceToNow(new Date(repositoryCache.syncedAt), { addSuffix: true })}
                    </p>
                  )}
                </div>
                {readiness.integrationId && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={refreshRepositoriesMutation.isPending || !readiness.canManage}
                    onClick={handleRefreshRepositories}
                  >
                    <RefreshCw
                      className={refreshRepositoriesMutation.isPending ? 'animate-spin' : undefined}
                    />
                    {refreshRepositoriesMutation.isPending
                      ? 'Refreshing...'
                      : 'Refresh repositories'}
                  </Button>
                )}
              </div>

              {repositoryCache.status === 'available' && repositories.length > 0 ? (
                <RepositoryMultiSelect<string>
                  repositories={repositories}
                  selectedIds={draft.selectedRepositoryIds}
                  onSelectionChange={selectedRepositoryIds => {
                    setValidationError(null);
                    setDraft(current => ({ ...current, selectedRepositoryIds }));
                  }}
                />
              ) : (
                <Alert>
                  <AlertCircle />
                  <AlertTitle>No cached repositories</AlertTitle>
                  <AlertDescription>
                    Refresh repositories after confirming the Workspace Access Token can read this
                    workspace.
                  </AlertDescription>
                </Alert>
              )}
              {validationError && (
                <p className="text-destructive text-sm" role="alert">
                  {validationError}
                </p>
              )}
            </div>

            <div className="space-y-3 border-t border-border pt-6">
              <Label>Review style</Label>
              <RadioGroup
                value={draft.reviewStyle}
                onValueChange={reviewStyle =>
                  setDraft(current => ({ ...current, reviewStyle: reviewStyle as ReviewStyle }))
                }
                className="gap-3"
              >
                {REVIEW_STYLES.map(style => {
                  const id = `bitbucket-review-style-${style.value}`;
                  return (
                    <div key={style.value} className="flex items-start gap-3">
                      <RadioGroupItem value={style.value} id={id} />
                      <div className="space-y-1">
                        <Label htmlFor={id}>{style.label}</Label>
                        <p className="text-muted-foreground text-sm">{style.description}</p>
                      </div>
                    </div>
                  );
                })}
              </RadioGroup>
            </div>

            <div className="space-y-3 border-t border-border pt-6">
              <div className="space-y-1">
                <Label>Focus areas</Label>
                <p className="text-muted-foreground text-sm">
                  Select areas that need extra attention.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {FOCUS_AREAS.map(area => {
                  const id = `bitbucket-focus-area-${area.id}`;
                  return (
                    <div key={area.id} className="flex items-start gap-3">
                      <Checkbox
                        id={id}
                        checked={draft.focusAreas.includes(area.id)}
                        onCheckedChange={() =>
                          setDraft(current => ({
                            ...current,
                            focusAreas: current.focusAreas.includes(area.id)
                              ? current.focusAreas.filter(focusArea => focusArea !== area.id)
                              : [...current.focusAreas, area.id],
                          }))
                        }
                      />
                      <div className="space-y-1">
                        <Label htmlFor={id}>{area.label}</Label>
                        <p className="text-muted-foreground text-sm">{area.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2 border-t border-border pt-6">
              <Label htmlFor="bitbucket-custom-instructions">Custom instructions (optional)</Label>
              <Textarea
                id="bitbucket-custom-instructions"
                value={draft.customInstructions}
                onChange={event =>
                  setDraft(current => ({ ...current, customInstructions: event.target.value }))
                }
                placeholder="Add repository-specific review guidance for your team."
                rows={4}
                className="resize-none"
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground text-sm" aria-live="polite">
              {saveMutation.isPending
                ? 'Saving changes...'
                : isDirty
                  ? 'Unsaved changes'
                  : 'All changes saved'}
            </span>
            <Button
              type="submit"
              className="min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled={!isDirty || saveMutation.isPending || !readiness.canManage}
            >
              <Save />
              {saveMutation.isPending ? 'Saving changes...' : 'Save changes'}
            </Button>
          </div>
        </form>

        {readiness.canTriggerManualReview && (
          <form
            className="mt-6 space-y-4 rounded-lg border border-status-warning-border bg-status-warning-surface p-4 sm:p-5"
            onSubmit={event => {
              event.preventDefault();
              handleManualReview();
            }}
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-status-warning-border bg-surface-raised text-status-warning-icon">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label
                      htmlFor="bitbucket-manual-review-url"
                      className="type-body-lg font-medium"
                    >
                      Admin area: manual review trigger
                    </Label>
                    <Badge
                      variant="secondary"
                      className="border-status-warning-border bg-status-warning-surface text-status-warning"
                    >
                      Kilo admin only
                    </Badge>
                  </div>
                  <p
                    id="bitbucket-manual-review-description"
                    className="text-muted-foreground text-sm"
                  >
                    Paste a Bitbucket Cloud pull request URL to queue a review immediately, without
                    waiting for webhook delivery.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  id="bitbucket-manual-review-url"
                  type="url"
                  value={manualReviewUrl}
                  onChange={event => {
                    setManualReviewUrl(event.target.value);
                    if (manualReviewError) setManualReviewError(null);
                  }}
                  placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
                  disabled={manualReviewMutation.isPending || !isEnabled}
                  aria-describedby="bitbucket-manual-review-description bitbucket-manual-review-error"
                  className="min-h-11 sm:min-h-9"
                />
                <Button
                  type="submit"
                  variant="outline"
                  className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                  disabled={
                    manualReviewMutation.isPending || !isEnabled || manualReviewUrl.trim() === ''
                  }
                >
                  <Play />
                  {manualReviewMutation.isPending ? 'Starting review...' : 'Start review'}
                </Button>
              </div>
            </div>
            {!isEnabled && (
              <p className="text-muted-foreground text-sm">
                Enable Bitbucket Code Reviewer before starting a manual review.
              </p>
            )}
            {manualReviewError && (
              <p
                id="bitbucket-manual-review-error"
                className="text-destructive text-sm"
                role="alert"
              >
                {manualReviewError}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
