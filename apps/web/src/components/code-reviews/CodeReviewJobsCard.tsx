'use client';

import { type ComponentType, type FormEvent, type ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ExternalLink,
  GitPullRequest,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Ban,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { CodeReviewStreamView } from './CodeReviewStreamView';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import {
  getAvailableThinkingEfforts,
  thinkingEffortLabel,
} from '@/lib/code-reviews/core/model-variants';
import {
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredRecoveryHref,
  isCodeReviewActionRequiredReason,
} from '@/lib/code-reviews/action-required-shared';
import {
  getCodeReviewRepositoryUrl,
  type CodeReviewUiPlatform,
} from '@/lib/code-reviews/code-review-links';

type Platform = CodeReviewUiPlatform;

type CodeReviewJobsCardProps = {
  organizationId?: string;
  platform?: Platform;
  localCodeReviewDevelopmentEnabled?: boolean;
  defaultModelSlug?: string | null;
  defaultThinkingEffort?: string | null;
};

type CodeReviewStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

const statusConfig: Record<
  CodeReviewStatus,
  {
    icon: ComponentType<{ className?: string }>;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    label: string;
  }
> = {
  pending: { icon: Clock, variant: 'secondary', label: 'Pending' },
  queued: { icon: Clock, variant: 'secondary', label: 'Queued' },
  running: { icon: Loader2, variant: 'default', label: 'Running' },
  completed: { icon: CheckCircle2, variant: 'default', label: 'Completed' },
  failed: { icon: XCircle, variant: 'destructive', label: 'Failed' },
  cancelled: { icon: Ban, variant: 'outline', label: 'Cancelled' },
  interrupted: { icon: AlertCircle, variant: 'outline', label: 'Interrupted' },
};

const PAGE_SIZE = 10;
const DEFAULT_THINKING_EFFORT_VALUE = '__default__';
const MANUAL_INSTRUCTIONS_MAX_LENGTH = 4_000;

function getManualJobUrlError(
  value: string,
  platform: Platform,
  localCodeReviewDevelopmentEnabled: boolean
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return platform === 'gitlab'
      ? 'Enter a GitLab merge request URL.'
      : 'Enter a GitHub pull request URL.';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return 'Enter a valid URL.';
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return 'URL must use http or https.';
  }

  if (platform === 'github') {
    const isGitHubPullRequest =
      parsedUrl.hostname === 'github.com' &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(parsedUrl.pathname);
    return isGitHubPullRequest
      ? null
      : 'Enter a GitHub pull request URL like https://github.com/owner/repo/pull/123.';
  }

  const isGitLabMergeRequest = /\/-\/merge_requests\/\d+\/?$/.test(parsedUrl.pathname);
  if (!isGitLabMergeRequest) {
    return 'Enter a GitLab merge request URL like https://gitlab.com/group/project/-/merge_requests/123.';
  }

  if (localCodeReviewDevelopmentEnabled && parsedUrl.hostname !== 'gitlab.com') {
    return 'Local GitLab jobs require a public gitlab.com merge request URL.';
  }

  return null;
}

function selectInitialManualJobModel(params: {
  configuredModelSlug?: string | null;
  defaultModel?: string;
  modelOptions: ModelOption[];
}): string {
  const configuredModelSlug = params.configuredModelSlug?.trim();
  if (configuredModelSlug && params.modelOptions.some(model => model.id === configuredModelSlug)) {
    return configuredModelSlug;
  }
  if (params.defaultModel && params.modelOptions.some(model => model.id === params.defaultModel)) {
    return params.defaultModel;
  }
  if (params.modelOptions.some(model => model.id === PRIMARY_DEFAULT_MODEL)) {
    return PRIMARY_DEFAULT_MODEL;
  }
  return (
    params.modelOptions[0]?.id ??
    configuredModelSlug ??
    params.defaultModel ??
    PRIMARY_DEFAULT_MODEL
  );
}

function selectInitialManualJobThinkingEffort(
  configuredThinkingEffort: string | null | undefined,
  modelSlug: string
): string | null {
  if (!configuredThinkingEffort) {
    return null;
  }
  return getAvailableThinkingEfforts(modelSlug).includes(configuredThinkingEffort)
    ? configuredThinkingEffort
    : null;
}

export function CodeReviewJobsCard({
  organizationId,
  platform = 'github',
  localCodeReviewDevelopmentEnabled = false,
  defaultModelSlug,
  defaultThinkingEffort,
}: CodeReviewJobsCardProps) {
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);
  const [manualJobDialogOpen, setManualJobDialogOpen] = useState(false);
  const [manualJobUrl, setManualJobUrl] = useState('');
  const [manualJobUrlTouched, setManualJobUrlTouched] = useState(false);
  const [manualJobModelSlug, setManualJobModelSlug] = useState(
    defaultModelSlug ?? PRIMARY_DEFAULT_MODEL
  );
  const [manualJobThinkingEffort, setManualJobThinkingEffort] = useState<string | null>(null);
  const [manualJobInstructions, setManualJobInstructions] = useState('');
  const [manualJobSubmitted, setManualJobSubmitted] = useState(false);
  const [manualJobSubmitError, setManualJobSubmitError] = useState<string | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { modelOptions, isLoadingModels, defaultModel } = useOrganizationModels(organizationId);

  const offset = (currentPage - 1) * PAGE_SIZE;
  const prLabel = platform === 'gitlab' ? 'merge requests' : 'pull requests';
  const changeLabel = platform === 'gitlab' ? 'merge request' : 'pull request';
  const platformLabel = platform === 'gitlab' ? 'GitLab' : 'GitHub';
  const urlPlaceholder =
    platform === 'gitlab'
      ? 'https://gitlab.com/group/project/-/merge_requests/123'
      : 'https://github.com/owner/repo/pull/123';
  const manualJobAvailableThinkingEfforts = getAvailableThinkingEfforts(manualJobModelSlug);
  const manualJobUrlError = getManualJobUrlError(
    manualJobUrl,
    platform,
    localCodeReviewDevelopmentEnabled
  );
  const showManualJobUrlError = (manualJobUrlTouched || manualJobSubmitted) && manualJobUrlError;
  const manualJobModelAllowed = modelOptions.some(model => model.id === manualJobModelSlug);
  const manualJobModelError =
    manualJobSubmitted &&
    !isLoadingModels &&
    (!manualJobModelSlug || modelOptions.length === 0 || !manualJobModelAllowed)
      ? 'Select a model available for this account.'
      : null;

  // Fetch code reviews with auto-refresh every 5 seconds if there are active jobs
  const { data, isLoading, isFetching } = useQuery({
    ...(organizationId
      ? trpc.codeReviews.listForOrganization.queryOptions({
          organizationId,
          limit: PAGE_SIZE,
          offset,
          platform,
        })
      : trpc.codeReviews.listForUser.queryOptions({
          limit: PAGE_SIZE,
          offset,
          platform,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result || !result.success) return false;
      const reviews = result.reviews || [];
      const hasActiveJobs = reviews.some(r => ['pending', 'queued', 'running'].includes(r.status));
      return hasActiveJobs ? 5000 : false; // Poll every 5s if active jobs
    },
  });

  const orgCreateManualReviewJobMutation = useMutation(
    trpc.organizations.reviewAgent.createManualReviewJob.mutationOptions({
      onSuccess: data => {
        void handleManualJobCreated(data);
      },
      onError: error => {
        setManualJobSubmitError(error.message);
        toast.error('Could not start Code Reviewer job', {
          description: error.message,
        });
      },
    })
  );

  const personalCreateManualReviewJobMutation = useMutation(
    trpc.personalReviewAgent.createManualReviewJob.mutationOptions({
      onSuccess: data => {
        void handleManualJobCreated(data);
      },
      onError: error => {
        setManualJobSubmitError(error.message);
        toast.error('Could not start Code Reviewer job', {
          description: error.message,
        });
      },
    })
  );

  const isManualJobSubmitting = organizationId
    ? orgCreateManualReviewJobMutation.isPending
    : personalCreateManualReviewJobMutation.isPending;
  const manualJobSubmitDisabled =
    isManualJobSubmitting || isLoadingModels || modelOptions.length === 0 || !manualJobModelAllowed;

  useEffect(() => {
    if (
      manualJobThinkingEffort &&
      !getAvailableThinkingEfforts(manualJobModelSlug).includes(manualJobThinkingEffort)
    ) {
      setManualJobThinkingEffort(null);
    }
  }, [manualJobModelSlug, manualJobThinkingEffort]);

  useEffect(() => {
    if (!manualJobDialogOpen || modelOptions.length === 0 || manualJobModelAllowed) {
      return;
    }

    const nextModelSlug = selectInitialManualJobModel({
      configuredModelSlug: defaultModelSlug,
      defaultModel,
      modelOptions,
    });
    setManualJobModelSlug(nextModelSlug);
    setManualJobThinkingEffort(
      selectInitialManualJobThinkingEffort(defaultThinkingEffort, nextModelSlug)
    );
  }, [
    defaultModel,
    defaultModelSlug,
    defaultThinkingEffort,
    manualJobDialogOpen,
    manualJobModelAllowed,
    modelOptions,
  ]);

  function resetManualJobForm() {
    const nextModelSlug = selectInitialManualJobModel({
      configuredModelSlug: defaultModelSlug,
      defaultModel,
      modelOptions,
    });
    setManualJobUrl('');
    setManualJobUrlTouched(false);
    setManualJobModelSlug(nextModelSlug);
    setManualJobThinkingEffort(
      selectInitialManualJobThinkingEffort(defaultThinkingEffort, nextModelSlug)
    );
    setManualJobInstructions('');
    setManualJobSubmitted(false);
    setManualJobSubmitError(null);
  }

  function handleManualJobDialogOpenChange(open: boolean) {
    setManualJobDialogOpen(open);
    if (open || !isManualJobSubmitting) {
      resetManualJobForm();
    }
  }

  async function invalidateJobsList() {
    await queryClient.invalidateQueries({
      queryKey: organizationId
        ? trpc.codeReviews.listForOrganization.queryKey({
            organizationId,
            limit: PAGE_SIZE,
            offset,
            platform,
          })
        : trpc.codeReviews.listForUser.queryKey({ limit: PAGE_SIZE, offset, platform }),
    });
  }

  async function handleManualJobCreated(data: {
    reviewId: string;
    outputMode: 'provider' | 'kilo';
  }) {
    toast.success('Code Reviewer job started', {
      description:
        data.outputMode === 'kilo'
          ? 'Findings will appear in Kilo and will not be posted.'
          : `Findings will be posted to ${platformLabel} when the job completes.`,
    });
    await invalidateJobsList();
    setManualJobDialogOpen(false);
    resetManualJobForm();
    router.push(`/code-reviews/${data.reviewId}`);
  }

  function handleManualJobSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setManualJobSubmitted(true);
    setManualJobUrlTouched(true);
    setManualJobSubmitError(null);

    if (manualJobUrlError) {
      return;
    }

    if (!manualJobModelSlug || modelOptions.length === 0 || !manualJobModelAllowed) {
      return;
    }

    if (platform === 'bitbucket') {
      setManualJobSubmitError('Manual Code Reviewer jobs are not supported for Bitbucket.');
      return;
    }

    const input = {
      platform,
      url: manualJobUrl.trim(),
      modelSlug: manualJobModelSlug,
      thinkingEffort: manualJobThinkingEffort,
      instructions: manualJobInstructions.trim() || undefined,
    };

    if (organizationId) {
      orgCreateManualReviewJobMutation.mutate({ organizationId, ...input });
    } else {
      personalCreateManualReviewJobMutation.mutate(input);
    }
  }

  function renderJobsCardHeader(description: ReactNode) {
    return (
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5" />
            Code Review Jobs
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button className="w-full gap-2 sm:w-auto" onClick={() => setManualJobDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New job
        </Button>
      </CardHeader>
    );
  }

  const manualJobDialog = (
    <Dialog open={manualJobDialogOpen} onOpenChange={handleManualJobDialogOpenChange}>
      <DialogContent className="grid max-h-[85vh] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Start Code Reviewer job</DialogTitle>
          <DialogDescription>
            Review one {platformLabel} {changeLabel} with the selected model and instructions.
          </DialogDescription>
        </DialogHeader>
        <form
          id="manual-code-review-job-form"
          onSubmit={handleManualJobSubmit}
          className="min-h-0 overflow-y-auto pr-1"
        >
          <div className="flex flex-col gap-4">
            {localCodeReviewDevelopmentEnabled && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Local read-only job</AlertTitle>
                <AlertDescription>
                  Public github.com and gitlab.com changes are supported. Kilo will not post
                  comments, statuses, or reactions.
                </AlertDescription>
              </Alert>
            )}

            {manualJobSubmitError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Can&apos;t start Code Reviewer job</AlertTitle>
                <AlertDescription>{manualJobSubmitError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="manual-code-review-url">{platformLabel} URL</Label>
              <Input
                id="manual-code-review-url"
                type="url"
                value={manualJobUrl}
                onChange={event => setManualJobUrl(event.target.value)}
                onBlur={() => setManualJobUrlTouched(true)}
                placeholder={urlPlaceholder}
                aria-invalid={!!showManualJobUrlError}
                aria-describedby={
                  showManualJobUrlError
                    ? 'manual-code-review-url-error'
                    : 'manual-code-review-url-help'
                }
                disabled={isManualJobSubmitting}
              />
              {showManualJobUrlError ? (
                <p id="manual-code-review-url-error" className="text-destructive text-sm">
                  {manualJobUrlError}
                </p>
              ) : (
                <p id="manual-code-review-url-help" className="text-muted-foreground text-sm">
                  Paste the {changeLabel} URL from the selected {platformLabel} tab.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <ModelCombobox
                label="Model"
                models={modelOptions}
                value={manualJobModelSlug}
                onValueChange={setManualJobModelSlug}
                isLoading={isLoadingModels}
                helperText="Choose the model for this review only."
                disabled={isManualJobSubmitting}
                required
                modal
              />
              {manualJobModelError && (
                <p className="text-destructive text-sm">{manualJobModelError}</p>
              )}
            </div>

            {manualJobAvailableThinkingEfforts.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="manual-code-review-thinking-effort">Thinking effort</Label>
                <Select
                  value={manualJobThinkingEffort ?? DEFAULT_THINKING_EFFORT_VALUE}
                  onValueChange={value =>
                    setManualJobThinkingEffort(
                      value === DEFAULT_THINKING_EFFORT_VALUE ? null : value
                    )
                  }
                  disabled={isManualJobSubmitting}
                >
                  <SelectTrigger id="manual-code-review-thinking-effort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_THINKING_EFFORT_VALUE}>Default</SelectItem>
                    {manualJobAvailableThinkingEfforts.map(variant => (
                      <SelectItem key={variant} value={variant}>
                        {thinkingEffortLabel(variant)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-sm">
                  Configure the model&apos;s reasoning intensity for this job.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="manual-code-review-instructions">Instructions</Label>
              <Textarea
                id="manual-code-review-instructions"
                value={manualJobInstructions}
                onChange={event => setManualJobInstructions(event.target.value)}
                maxLength={MANUAL_INSTRUCTIONS_MAX_LENGTH}
                placeholder="Focus on the risk areas that matter for this change."
                className="min-h-28 resize-none"
                disabled={isManualJobSubmitting}
              />
              <p className="text-muted-foreground text-sm">
                Optional one-off instructions for this review. {manualJobInstructions.length}/
                {MANUAL_INSTRUCTIONS_MAX_LENGTH} characters.
              </p>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setManualJobDialogOpen(false)}
            disabled={isManualJobSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="manual-code-review-job-form"
            disabled={manualJobSubmitDisabled}
          >
            {isManualJobSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Start job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Retrigger mutation for failed/cancelled/interrupted reviews
  const retriggerMutation = useMutation(
    trpc.codeReviews.retrigger.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review retriggered', {
          description: 'The code review has been queued for processing.',
        });
        setActionInProgressId(null);
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.codeReviews.listForOrganization.queryKey({
                organizationId,
                limit: PAGE_SIZE,
                offset,
                platform,
              })
            : trpc.codeReviews.listForUser.queryKey({ limit: PAGE_SIZE, offset, platform }),
        });
      },
      onError: error => {
        toast.error('Failed to retrigger code review', {
          description: error.message,
        });
        setActionInProgressId(null);
      },
    })
  );

  // Cancel mutation for pending/queued/running reviews
  const cancelMutation = useMutation(
    trpc.codeReviews.cancel.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review cancelled', {
          description: 'The code review has been cancelled.',
        });
        setActionInProgressId(null);
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.codeReviews.listForOrganization.queryKey({
                organizationId,
                limit: PAGE_SIZE,
                offset,
                platform,
              })
            : trpc.codeReviews.listForUser.queryKey({ limit: PAGE_SIZE, offset, platform }),
        });
      },
      onError: error => {
        toast.error('Failed to cancel code review', {
          description: error.message,
        });
        setActionInProgressId(null);
      },
    })
  );

  if (isLoading) {
    return (
      <>
        <Card>{renderJobsCardHeader('Loading jobs...')}</Card>
        {manualJobDialog}
      </>
    );
  }

  const reviews = data?.success ? data.reviews : [];
  const total = data?.success ? data.total : 0;
  const hasMore = data?.success ? data.hasMore : false;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrevious = currentPage > 1;
  const hasNext = hasMore;

  // Show empty state only on first page with no reviews
  if (reviews.length === 0 && currentPage === 1) {
    return (
      <>
        <Card>
          {renderJobsCardHeader('No code reviews yet')}
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Code review jobs will appear here when {prLabel} are reviewed.
            </p>
          </CardContent>
        </Card>
        {manualJobDialog}
      </>
    );
  }

  return (
    <>
      <Card>
        {renderJobsCardHeader(
          total > 0 ? (
            <>
              Showing {offset + 1}-{Math.min(offset + reviews.length, total)} of {total} code
              reviews
            </>
          ) : (
            'No code reviews'
          )
        )}
        <CardContent>
          <div className="space-y-3">
            {reviews.map(review => {
              const statusInfo = statusConfig[review.status as CodeReviewStatus] ?? {
                icon: AlertCircle,
                variant: 'outline' as const,
                label: review.status,
              };
              const StatusIcon = statusInfo.icon;
              const isExpanded = expandedReviewId === review.id;
              const canShowStream = ['running', 'queued'].includes(review.status);
              const actionRequiredReason = isCodeReviewActionRequiredReason(review.terminal_reason)
                ? review.terminal_reason
                : null;
              const actionRequiredCopy = actionRequiredReason
                ? getCodeReviewActionRequiredCopy(actionRequiredReason)
                : null;
              const actionRequiredRecoveryHref = actionRequiredReason
                ? getCodeReviewActionRequiredRecoveryHref(
                    actionRequiredReason,
                    organizationId,
                    platform
                  )
                : null;

              return (
                <div key={review.id} className="space-y-2">
                  <div className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-3 transition-colors">
                    {/* Status Icon */}
                    <div className="mt-1">
                      <StatusIcon
                        className={`h-5 w-5 ${review.status === 'running' ? 'animate-spin' : ''} ${
                          review.status === 'completed'
                            ? 'text-green-500'
                            : review.status === 'failed'
                              ? 'text-red-500'
                              : 'text-muted-foreground'
                        }`}
                      />
                    </div>

                    {/* PR Info */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/code-reviews/${review.id}`}
                            className="text-foreground hover:text-primary text-sm font-medium transition-colors hover:underline"
                          >
                            {review.pr_title}
                          </Link>
                          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                            <a
                              href={getCodeReviewRepositoryUrl(platform, review.pr_url)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-primary transition-colors hover:underline"
                            >
                              {review.repo_full_name}
                            </a>
                            <span>&middot;</span>
                            <a
                              href={review.pr_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-primary inline-flex items-center gap-1 transition-colors hover:underline"
                            >
                              #{review.pr_number}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <span>&middot;</span>
                            <span>by @{review.pr_author}</span>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <Badge variant={statusInfo.variant} className="gap-1 whitespace-nowrap">
                          <StatusIcon
                            className={`h-3 w-3 ${review.status === 'running' ? 'animate-spin' : ''}`}
                          />
                          {statusInfo.label}
                        </Badge>
                      </div>

                      {/* Timestamps & Session Link */}
                      <div className="text-muted-foreground flex items-center gap-3 text-xs">
                        {review.started_at && (
                          <span>
                            Started{' '}
                            {formatDistanceToNow(new Date(review.started_at), { addSuffix: true })}
                          </span>
                        )}
                        {review.completed_at && (
                          <span>
                            Completed{' '}
                            {formatDistanceToNow(new Date(review.completed_at), {
                              addSuffix: true,
                            })}
                          </span>
                        )}
                        {!review.started_at && (
                          <span>
                            Created{' '}
                            {formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}
                          </span>
                        )}
                      </div>

                      {/* Error Message */}
                      {review.error_message && (
                        <div className="text-destructive mt-1 text-xs">
                          Error: {review.error_message}
                        </div>
                      )}

                      {/* View Progress Button */}
                      {canShowStream && (
                        <div className="mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setExpandedReviewId(isExpanded ? null : review.id)}
                            className="gap-2"
                          >
                            {isExpanded ? (
                              <>
                                <ChevronUp className="h-3 w-3" />
                                Hide Progress
                              </>
                            ) : (
                              <>
                                <ChevronDown className="h-3 w-3" />
                                View Progress
                              </>
                            )}
                          </Button>
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="mt-2 flex gap-2">
                        {/* Cancel Button for pending/queued/running reviews */}
                        {['pending', 'queued', 'running'].includes(review.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setActionInProgressId(review.id);
                              cancelMutation.mutate({ reviewId: review.id });
                            }}
                            disabled={actionInProgressId === review.id && cancelMutation.isPending}
                            className="gap-2"
                          >
                            <Ban
                              className={`h-3 w-3 ${actionInProgressId === review.id && cancelMutation.isPending ? 'animate-spin' : ''}`}
                            />
                            {actionInProgressId === review.id && cancelMutation.isPending
                              ? 'Cancelling...'
                              : 'Cancel'}
                          </Button>
                        )}

                        {/* Retry Button for failed/cancelled/interrupted reviews */}
                        {['failed', 'cancelled', 'interrupted'].includes(review.status) &&
                          actionRequiredCopy &&
                          actionRequiredRecoveryHref && (
                            <Button variant="outline" size="sm" asChild className="gap-2">
                              {actionRequiredRecoveryHref.startsWith('mailto:') ? (
                                <a href={actionRequiredRecoveryHref}>
                                  {actionRequiredCopy.recoveryLabel}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                <Link href={actionRequiredRecoveryHref}>
                                  {actionRequiredCopy.recoveryLabel}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              )}
                            </Button>
                          )}
                        {['failed', 'cancelled', 'interrupted'].includes(review.status) &&
                          !actionRequiredReason && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setActionInProgressId(review.id);
                                retriggerMutation.mutate({ reviewId: review.id });
                              }}
                              disabled={
                                actionInProgressId === review.id && retriggerMutation.isPending
                              }
                              className="gap-2"
                            >
                              <RotateCcw
                                className={`h-3 w-3 ${actionInProgressId === review.id && retriggerMutation.isPending ? 'animate-spin' : ''}`}
                              />
                              {actionInProgressId === review.id && retriggerMutation.isPending
                                ? 'Retrying...'
                                : 'Retry'}
                            </Button>
                          )}
                      </div>
                    </div>
                  </div>

                  {/* Streaming View (Expanded) */}
                  {isExpanded && canShowStream && (
                    <CodeReviewStreamView
                      reviewId={review.id}
                      onComplete={() => {
                        // Refetch reviews when complete
                        window.location.reload();
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination Controls */}
          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <div className="text-muted-foreground text-sm">
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={!hasPrevious || isFetching}
                  className="flex items-center gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => p + 1)}
                  disabled={!hasNext || isFetching}
                  className="flex items-center gap-1"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {manualJobDialog}
    </>
  );
}
