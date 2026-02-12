'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { ReviewConfigForm } from '@/components/code-reviews/ReviewConfigForm';
import { CodeReviewJobsCard } from '@/components/code-reviews/CodeReviewJobsCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Rocket, ExternalLink, Settings2, ListChecks } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitLabLogo } from '@/components/auth/GitLabLogo';
import { GitHubLogo } from '@/components/auth/GitHubLogo';

type Platform = 'github' | 'gitlab';

type ReviewAgentPageClientProps = {
  organizationId: string;
  organizationName: string;
  successMessage?: string;
  errorMessage?: string;
  initialPlatform?: Platform;
};

export function ReviewAgentPageClient({
  organizationId,
  organizationName,
  successMessage,
  errorMessage,
  initialPlatform = 'github',
}: ReviewAgentPageClientProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const selectedPlatform = initialPlatform;

  const handlePlatformChange = (platform: Platform) => {
    const params = new URLSearchParams();
    if (platform !== 'github') {
      params.set('platform', platform);
    }
    const queryString = params.toString();
    router.push(
      `/organizations/${organizationId}/code-reviews${queryString ? `?${queryString}` : ''}`
    );
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

  const isGitHubAppInstalled =
    githubStatusData?.connected && githubStatusData?.integration?.isValid;
  const isGitLabConnected = gitlabStatusData?.connected && gitlabStatusData?.integration?.isValid;

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
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold">Code Reviewer</h1>
          <Badge variant="new">new</Badge>
        </div>
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
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="github" className="flex items-center gap-2">
            <GitHubLogo className="h-4 w-4" />
            GitHub
            {isGitHubAppInstalled && (
              <Badge
                variant="outline"
                className="ml-1 border-green-500/30 bg-green-500/10 text-xs text-green-400"
              >
                Connected
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="gitlab" className="flex items-center gap-2">
            <GitLabLogo className="h-4 w-4" />
            GitLab
            {isGitLabConnected && (
              <Badge
                variant="outline"
                className="ml-1 border-green-500/30 bg-green-500/10 text-xs text-green-400"
              >
                Connected
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* GitHub Tab Content */}
        <TabsContent value="github" className="mt-6 space-y-6">
          {/* GitHub App Required Alert */}
          {!isGitHubAppInstalled && (
            <Alert>
              <Rocket className="h-4 w-4" />
              <AlertTitle>GitHub App Required</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  The Kilo GitHub App must be installed to use Code Reviewer. The app automatically
                  manages workflows and triggers reviews on your pull requests.
                </p>
                <Link href={`/organizations/${organizationId}/integrations/github`}>
                  <Button variant="default" size="sm">
                    Install GitHub App
                    <ExternalLink className="ml-2 h-3 w-3" />
                  </Button>
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {/* GitHub Configuration Tabs */}
          <Tabs defaultValue="config" className="w-full">
            <TabsList className="grid w-full max-w-2xl grid-cols-2">
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
              <TabsTrigger
                value="jobs"
                className="flex items-center gap-2"
                disabled={!isGitHubAppInstalled}
              >
                <ListChecks className="h-4 w-4" />
                Jobs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-6 space-y-4">
              <ReviewConfigForm organizationId={organizationId} platform="github" />
            </TabsContent>

            <TabsContent value="jobs" className="mt-6 space-y-4">
              {isGitHubAppInstalled ? (
                <CodeReviewJobsCard organizationId={organizationId} platform="github" />
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
          </Tabs>
        </TabsContent>

        {/* GitLab Tab Content */}
        <TabsContent value="gitlab" className="mt-6 space-y-6">
          {/* GitLab Connection Required Alert */}
          {!isGitLabConnected && (
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

          {/* GitLab Configuration Tabs */}
          <Tabs defaultValue="config" className="w-full">
            <TabsList className="grid w-full max-w-2xl grid-cols-2">
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
              <TabsTrigger
                value="jobs"
                className="flex items-center gap-2"
                disabled={!isGitLabConnected}
              >
                <ListChecks className="h-4 w-4" />
                Jobs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-6 space-y-4">
              <ReviewConfigForm
                organizationId={organizationId}
                platform="gitlab"
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
              {isGitLabConnected ? (
                <CodeReviewJobsCard organizationId={organizationId} platform="gitlab" />
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
          </Tabs>
        </TabsContent>
      </Tabs>
    </>
  );
}
