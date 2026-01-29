'use client';

import { useEffect, useState } from 'react';
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
import { PageContainer } from '@/components/layouts/PageContainer';
import { GitLabLogo } from '@/components/auth/GitLabLogo';

type ReviewAgentPageClientProps = {
  userId: string;
  userName: string;
  successMessage?: string;
  errorMessage?: string;
};

type Platform = 'github' | 'gitlab';

export function ReviewAgentPageClient({
  successMessage,
  errorMessage,
}: ReviewAgentPageClientProps) {
  const trpc = useTRPC();
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>('github');

  // Fetch GitHub App installation status
  const { data: githubStatusData } = useQuery(
    trpc.personalReviewAgent.getGitHubStatus.queryOptions()
  );

  // Fetch GitLab OAuth integration status
  const { data: gitlabStatusData } = useQuery(
    trpc.personalReviewAgent.getGitLabStatus.queryOptions()
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
    <PageContainer>
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold">Code Reviews</h1>
          <Badge variant="beta">beta</Badge>
        </div>
        <p className="text-muted-foreground">
          Automate code reviews with AI-powered analysis for your repositories
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
        onValueChange={v => setSelectedPlatform(v as Platform)}
        className="w-full"
      >
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="github" className="flex items-center gap-2">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
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
                  The Kilo GitHub App must be installed to use Code Reviews for GitHub. The app
                  automatically manages workflows and triggers reviews on your pull requests.
                </p>
                <Link href="/integrations/github">
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
              <ReviewConfigForm platform="github" />
            </TabsContent>

            <TabsContent value="jobs" className="mt-6 space-y-4">
              {isGitHubAppInstalled ? (
                <CodeReviewJobsCard platform="github" />
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
                <Link href="/integrations/gitlab">
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
                <CodeReviewJobsCard platform="gitlab" />
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
    </PageContainer>
  );
}
