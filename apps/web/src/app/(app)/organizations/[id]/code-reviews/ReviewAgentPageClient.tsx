'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { ReviewConfigForm } from '@/components/code-reviews/ReviewConfigForm';
import { BitbucketReviewConfigForm } from '@/components/code-reviews/BitbucketReviewConfigForm';
import { CodeReviewActionRequiredAlert } from '@/components/code-reviews/CodeReviewActionRequiredAlert';
import { CodeReviewJobsCard } from '@/components/code-reviews/CodeReviewJobsCard';
import { ReviewMemoryPanel } from '@/components/code-reviews/ReviewMemoryPanel';
import { CodeReviewAnalyticsPanel } from '@/components/code-reviews/analytics/CodeReviewAnalyticsPanel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertCircle,
  Brain,
  ChartColumnIncreasing,
  ExternalLink,
  ArrowLeft,
  ListChecks,
  Rocket,
  Settings2,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { CODE_REVIEW_COUNCIL_FLAG } from '@/lib/code-reviews/core/council-selection';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitLabLogo } from '@/components/auth/GitLabLogo';
import { GitHubLogo } from '@/components/auth/GitHubLogo';
import { BitbucketLogo } from '@/components/auth/BitbucketLogo';

type Platform = 'github' | 'gitlab' | 'bitbucket';
type BitbucketView = 'config' | 'jobs';

type ReviewAgentPageClientProps = {
  organizationId: string;
  organizationName: string;
  successMessage?: string;
  errorMessage?: string;
  initialPlatform?: Platform;
  localCodeReviewDevelopmentEnabled?: boolean;
  returnTo?: string;
  initialBitbucketView?: BitbucketView;
};

export function ReviewAgentPageClient({
  organizationId,
  organizationName,
  successMessage,
  errorMessage,
  initialPlatform = 'github',
  localCodeReviewDevelopmentEnabled = false,
  returnTo,
  initialBitbucketView = 'config',
}: ReviewAgentPageClientProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const selectedPlatform = initialPlatform;

  // The council UI shows for `localMode || (entitled && rolloutFlag)`. Entitlement only
  // matters in the second branch, so skip the (DB-backed) entitlement query unless the
  // rollout flag is on AND we're not in local mode (local mode bypasses entitlement). This
  // avoids a per-page-load entitlement lookup for the users who can't see council anyway;
  // server-side creation still enforces entitlement regardless.
  const councilFlagEnabled = useFeatureFlagEnabled(CODE_REVIEW_COUNCIL_FLAG);
  const { data: councilEntitlement } = useQuery(
    trpc.organizations.reviewAgent.getCouncilEntitlement.queryOptions(
      { organizationId },
      { enabled: !localCodeReviewDevelopmentEnabled && !!councilFlagEnabled }
    )
  );
  const councilEntitled = councilEntitlement?.entitled ?? false;
  // Same gate as the manual council UI: local dev, or an entitled org behind the rollout flag.
  const councilUiEnabled =
    localCodeReviewDevelopmentEnabled || (councilEntitled && !!councilFlagEnabled);

  const handlePlatformChange = (platform: Platform) => {
    const params = new URLSearchParams();
    if (platform !== 'github') {
      params.set('platform', platform);
    }
    if (returnTo) {
      params.set('returnTo', returnTo);
    }
    const queryString = params.toString();
    router.push(
      `/organizations/${organizationId}/code-reviews${queryString ? `?${queryString}` : ''}`
    );
  };

  const handleBitbucketViewChange = (view: string) => {
    const params = new URLSearchParams({ platform: 'bitbucket' });
    if (view === 'jobs') params.set('view', 'jobs');
    if (returnTo) params.set('returnTo', returnTo);
    router.push(`/organizations/${organizationId}/code-reviews?${params.toString()}`);
  };

  // Fetch GitHub App installation status
  const { data: githubStatusData } = useQuery(
    trpc.organizations.reviewAgent.getGitHubStatus.queryOptions({
      organizationId,
    })
  );

  // Fetch GitLab OAuth integration status
  const { data: gitlabStatusData } = useQuery(
    trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({
      organizationId,
    })
  );

  const {
    data: bitbucketReadinessData,
    isLoading: isLoadingBitbucketReadiness,
    error: bitbucketReadinessError,
  } = useQuery(
    trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
      organizationId,
    })
  );

  const { data: selectedConfigData } = useQuery(
    trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
      organizationId,
      platform: selectedPlatform,
    })
  );
  const selectedActionRequired = selectedConfigData?.actionRequired ?? null;

  const isGitHubAppInstalled =
    githubStatusData?.connected && githubStatusData?.integration?.isValid;
  const isGitLabConnected = gitlabStatusData?.connected && gitlabStatusData?.integration?.isValid;
  const canUseGitHubJobs = isGitHubAppInstalled || localCodeReviewDevelopmentEnabled;
  const canUseGitLabJobs = isGitLabConnected || localCodeReviewDevelopmentEnabled;
  const returnPath = returnTo
    ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}code_reviewer_return=true`
    : null;
  const githubIntegrationPath = returnTo
    ? `/organizations/${organizationId}/integrations/github?${new URLSearchParams({ returnTo })}`
    : `/organizations/${organizationId}/integrations/github`;
  const isBitbucketConnected = bitbucketReadinessData?.connected ?? false;
  const isBitbucketReady = bitbucketReadinessData?.ready ?? false;

  // Show toast messages from URL params
  useEffect(() => {
    if (successMessage === 'github_connected') {
      toast.success('GitHub account connected successfully');
    }
    if (successMessage === 'gitlab_connected') {
      toast.success('GitLab account connected successfully');
    }
    if (errorMessage) {
      toast.error('An error occurred', {
        description: errorMessage.replace(/_/g, ' '),
      });
    }
  }, [successMessage, errorMessage]);

  return (
    <>
      <SetPageTitle title="Code Reviewer">
        <Badge variant="new">new</Badge>
      </SetPageTitle>
      {returnPath && (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href={returnPath}>
              <ArrowLeft className="size-4" />
              Return to setup
            </Link>
          </Button>
        </div>
      )}
      {/* Header */}
      <div className="space-y-2">
        <p className="text-muted-foreground">
          Automate code reviews with AI-powered analysis for {organizationName}
        </p>
        <a
          href="https://kilo.ai/docs/advanced-usage/code-reviews"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* Platform Selection Tabs */}
      <Tabs
        value={selectedPlatform}
        onValueChange={v => handlePlatformChange(v as Platform)}
        className="w-full"
      >
        <TabsList className="grid h-auto w-full max-w-3xl grid-cols-1 sm:grid-cols-3">
          <TabsTrigger value="github" className="flex min-h-11 items-center gap-2 sm:min-h-9">
            <GitHubLogo className="h-4 w-4" />
            GitHub
            {isGitHubAppInstalled && (
              <Badge
                variant="outline"
                className="border-status-success-border bg-status-success-surface text-status-success ml-1 text-xs"
              >
                Connected
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="gitlab" className="flex min-h-11 items-center gap-2 sm:min-h-9">
            <GitLabLogo className="h-4 w-4" />
            GitLab
            {isGitLabConnected && (
              <Badge
                variant="outline"
                className="border-status-success-border bg-status-success-surface text-status-success ml-1 text-xs"
              >
                Connected
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="bitbucket" className="flex min-h-11 items-center gap-2 sm:min-h-9">
            <BitbucketLogo className="h-4 w-4" />
            Bitbucket
            {isBitbucketConnected && (
              <Badge
                variant="outline"
                className={
                  isBitbucketReady
                    ? 'border-status-success-border bg-status-success-surface text-status-success ml-1 text-xs'
                    : 'border-status-warning-border bg-status-warning-surface text-status-warning ml-1 text-xs'
                }
              >
                {isBitbucketReady ? 'Connected' : 'Permissions'}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* GitHub Tab Content */}
        <TabsContent value="github" className="mt-6 space-y-6">
          {/* GitHub App Required Alert */}
          {!isGitHubAppInstalled && !localCodeReviewDevelopmentEnabled && (
            <Alert>
              <Rocket className="h-4 w-4" />
              <AlertTitle>GitHub App Required</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  The Kilo GitHub App must be installed to use Code Reviewer. The app automatically
                  manages workflows and triggers reviews on your pull requests.
                </p>
                <Link href={githubIntegrationPath}>
                  <Button variant="default" size="sm">
                    Install GitHub App
                    <ExternalLink className="ml-2 h-3 w-3" />
                  </Button>
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {selectedPlatform === 'github' && selectedActionRequired && (
            <CodeReviewActionRequiredAlert
              actionRequired={selectedActionRequired}
              organizationId={organizationId}
              platform={selectedPlatform}
            />
          )}

          {/* GitHub Configuration Tabs */}
          <Tabs defaultValue="config" className="w-full">
            <TabsList className="grid h-auto w-full max-w-2xl grid-cols-2 sm:grid-cols-4">
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
              <TabsTrigger
                value="jobs"
                className="flex items-center gap-2"
                disabled={!canUseGitHubJobs}
              >
                <ListChecks className="h-4 w-4" />
                Jobs
              </TabsTrigger>
              <TabsTrigger
                value="memory"
                className="flex items-center gap-2"
                disabled={!isGitHubAppInstalled}
              >
                <Brain className="h-4 w-4" />
                Memory
              </TabsTrigger>
              <TabsTrigger value="analytics" className="flex items-center gap-2">
                <ChartColumnIncreasing className="h-4 w-4" />
                Analytics
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-6 space-y-4">
              <ReviewConfigForm
                organizationId={organizationId}
                platform="github"
                councilUiEnabled={councilUiEnabled}
              />
            </TabsContent>

            <TabsContent value="jobs" className="mt-6 space-y-4">
              {canUseGitHubJobs ? (
                <CodeReviewJobsCard
                  organizationId={organizationId}
                  platform="github"
                  localCodeReviewDevelopmentEnabled={localCodeReviewDevelopmentEnabled}
                  defaultModelSlug={selectedConfigData?.modelSlug}
                  defaultThinkingEffort={selectedConfigData?.thinkingEffort}
                  councilEntitled={councilEntitled}
                />
              ) : (
                <Alert>
                  <ListChecks className="h-4 w-4" />
                  <AlertTitle>No Jobs Yet</AlertTitle>
                  <AlertDescription>
                    Install the GitHub App and configure your review settings to see code review
                    jobs here.
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>

            <TabsContent value="memory" className="mt-6 space-y-4">
              {isGitHubAppInstalled ? (
                <ReviewMemoryPanel organizationId={organizationId} platform="github" />
              ) : (
                <Alert>
                  <Brain className="h-4 w-4" />
                  <AlertTitle>No memory yet</AlertTitle>
                  <AlertDescription>
                    Install the GitHub App before enabling review memory.
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>

            <TabsContent value="analytics" className="mt-6 space-y-4">
              <CodeReviewAnalyticsPanel organizationId={organizationId} platform="github" />
            </TabsContent>
          </Tabs>
        </TabsContent>

        {/* GitLab Tab Content */}
        <TabsContent value="gitlab" className="mt-6 space-y-6">
          {/* GitLab Connection Required Alert */}
          {!isGitLabConnected && !localCodeReviewDevelopmentEnabled && (
            <Alert>
              <Rocket className="h-4 w-4" />
              <AlertTitle>GitLab Connection Required</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  Connect your GitLab account to use Code Reviews for GitLab. You'll also need to
                  configure a webhook in your GitLab project settings.
                </p>
                <Link href={`/organizations/${organizationId}/integrations/gitlab`}>
                  <Button variant="default" size="sm">
                    Connect GitLab
                    <ExternalLink className="ml-2 h-3 w-3" />
                  </Button>
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {selectedPlatform === 'gitlab' && selectedActionRequired && (
            <CodeReviewActionRequiredAlert
              actionRequired={selectedActionRequired}
              organizationId={organizationId}
              platform={selectedPlatform}
            />
          )}

          {/* GitLab Configuration Tabs */}
          <Tabs defaultValue="config" className="w-full">
            <TabsList className="grid h-auto w-full max-w-2xl grid-cols-2 sm:grid-cols-3">
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
              <TabsTrigger
                value="jobs"
                className="flex items-center gap-2"
                disabled={!canUseGitLabJobs}
              >
                <ListChecks className="h-4 w-4" />
                Jobs
              </TabsTrigger>
              <TabsTrigger value="analytics" className="flex items-center gap-2">
                <ChartColumnIncreasing className="h-4 w-4" />
                Analytics
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-6 space-y-4">
              <ReviewConfigForm
                organizationId={organizationId}
                platform="gitlab"
                councilUiEnabled={councilUiEnabled}
                gitlabStatusData={
                  gitlabStatusData
                    ? {
                        connected: gitlabStatusData.connected,
                        integration: gitlabStatusData.integration
                          ? {
                              isValid: gitlabStatusData.integration.isValid,
                              webhookSecret: gitlabStatusData.integration.webhookSecret,
                              instanceUrl: gitlabStatusData.integration.instanceUrl,
                            }
                          : undefined,
                      }
                    : undefined
                }
              />
            </TabsContent>

            <TabsContent value="jobs" className="mt-6 space-y-4">
              {canUseGitLabJobs ? (
                <CodeReviewJobsCard
                  organizationId={organizationId}
                  platform="gitlab"
                  localCodeReviewDevelopmentEnabled={localCodeReviewDevelopmentEnabled}
                  defaultModelSlug={selectedConfigData?.modelSlug}
                  defaultThinkingEffort={selectedConfigData?.thinkingEffort}
                  councilEntitled={councilEntitled}
                />
              ) : (
                <Alert>
                  <ListChecks className="h-4 w-4" />
                  <AlertTitle>No Jobs Yet</AlertTitle>
                  <AlertDescription>
                    Connect GitLab and configure your review settings to see code review jobs here.
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>

            <TabsContent value="analytics" className="mt-6 space-y-4">
              <CodeReviewAnalyticsPanel organizationId={organizationId} platform="gitlab" />
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="bitbucket" className="mt-6 space-y-6">
          {selectedPlatform === 'bitbucket' && selectedActionRequired && (
            <CodeReviewActionRequiredAlert
              actionRequired={selectedActionRequired}
              organizationId={organizationId}
              platform="bitbucket"
            />
          )}

          <Tabs
            value={initialBitbucketView}
            onValueChange={handleBitbucketViewChange}
            className="w-full"
          >
            <TabsList className="grid h-auto w-full max-w-md grid-cols-2">
              <TabsTrigger value="config" className="flex min-h-11 items-center gap-2 sm:min-h-9">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
              <TabsTrigger value="jobs" className="flex min-h-11 items-center gap-2 sm:min-h-9">
                <ListChecks className="h-4 w-4" />
                Jobs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-6 space-y-4">
              {isLoadingBitbucketReadiness ? (
                <Alert>
                  <BitbucketLogo />
                  <AlertTitle>Checking Bitbucket connection</AlertTitle>
                  <AlertDescription>Loading Workspace Access Token status...</AlertDescription>
                </Alert>
              ) : bitbucketReadinessError ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Bitbucket status is unavailable</AlertTitle>
                  <AlertDescription>{bitbucketReadinessError.message}</AlertDescription>
                </Alert>
              ) : !isBitbucketConnected ? (
                <Alert>
                  <BitbucketLogo />
                  <AlertTitle>Bitbucket connection required</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>
                      Connect an organization Workspace Access Token before configuring Bitbucket
                      Code Reviewer.
                    </p>
                    <Button asChild size="sm" className="min-h-11 sm:min-h-9">
                      <Link href={`/organizations/${organizationId}/integrations/bitbucket`}>
                        Connect Bitbucket
                        <ExternalLink className="ml-2 h-3 w-3" />
                      </Link>
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {!isBitbucketReady && bitbucketReadinessData && (
                    <Alert variant="warning">
                      <AlertCircle />
                      <AlertTitle>Code Reviewer permissions required</AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          Replace the Workspace Access Token with one that includes:{' '}
                          {bitbucketReadinessData.missingRequiredScopes.join(', ')}.
                        </p>
                        <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-9">
                          <Link href={`/organizations/${organizationId}/integrations/bitbucket`}>
                            Replace Bitbucket token
                            <ExternalLink className="ml-2 h-3 w-3" />
                          </Link>
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  <BitbucketReviewConfigForm organizationId={organizationId} />
                </>
              )}
            </TabsContent>

            <TabsContent value="jobs" className="mt-6 space-y-4">
              <CodeReviewJobsCard organizationId={organizationId} platform="bitbucket" />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </>
  );
}
