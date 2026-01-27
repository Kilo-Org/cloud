'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ReviewConfigForm } from '@/components/code-reviews/ReviewConfigForm';
import { CodeReviewJobsCard } from '@/components/code-reviews/CodeReviewJobsCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Rocket,
  ExternalLink,
  Settings2,
  ListChecks,
  Copy,
  Check,
  Info,
  RefreshCw,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  const queryClient = useQueryClient();
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>('github');
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const [copiedWebhookSecret, setCopiedWebhookSecret] = useState(false);
  const [regeneratedSecret, setRegeneratedSecret] = useState<string | null>(null);

  // Fetch GitHub App installation status
  const { data: githubStatusData } = useQuery(
    trpc.personalReviewAgent.getGitHubStatus.queryOptions()
  );

  // Fetch GitLab OAuth integration status
  const { data: gitlabStatusData } = useQuery(
    trpc.personalReviewAgent.getGitLabStatus.queryOptions()
  );

  // Mutation for regenerating webhook secret
  const regenerateSecretMutation = useMutation(
    trpc.gitlab.regenerateWebhookSecret.mutationOptions({
      onSuccess: data => {
        setRegeneratedSecret(data.webhookSecret);
        toast.success('Webhook secret regenerated successfully');
        // Invalidate the GitLab status query to refresh the data
        void queryClient.invalidateQueries({
          queryKey: trpc.personalReviewAgent.getGitLabStatus.queryKey(),
        });
      },
      onError: error => {
        toast.error('Failed to regenerate webhook secret', {
          description: error.message,
        });
      },
    })
  );

  const handleRegenerateSecret = () => {
    setRegeneratedSecret(null); // Clear any previously shown secret
    regenerateSecretMutation.mutate({});
  };

  const handleCopyRegeneratedSecret = async () => {
    if (regeneratedSecret) {
      await navigator.clipboard.writeText(regeneratedSecret);
      setCopiedWebhookSecret(true);
      toast.success('New webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

  const isGitHubAppInstalled =
    githubStatusData?.connected && githubStatusData?.integration?.isValid;
  const isGitLabConnected = gitlabStatusData?.connected && gitlabStatusData?.integration?.isValid;

  // Get webhook URL for GitLab
  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webhooks/gitlab`
      : '/api/webhooks/gitlab';

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

  const handleCopyWebhookUrl = async () => {
    await navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhookUrl(true);
    toast.success('Webhook URL copied to clipboard');
    setTimeout(() => setCopiedWebhookUrl(false), 2000);
  };

  const handleCopyWebhookSecret = async () => {
    const secret = gitlabStatusData?.integration?.webhookSecret;
    if (secret) {
      await navigator.clipboard.writeText(secret);
      setCopiedWebhookSecret(true);
      toast.success('Webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

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

          {/* GitLab Webhook Setup Card - Show when connected */}
          {isGitLabConnected && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Info className="h-5 w-5" />
                  Webhook Configuration
                </CardTitle>
                <CardDescription>
                  Configure a webhook in your GitLab project to enable automatic code reviews on
                  merge requests
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Webhook URL</label>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                      {webhookUrl}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyWebhookUrl}
                      className="shrink-0"
                    >
                      {copiedWebhookUrl ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Secret Token</label>
                  {regeneratedSecret ? (
                    <>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                          {regeneratedSecret}
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleCopyRegeneratedSecret}
                          className="shrink-0"
                        >
                          {copiedWebhookSecret ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
                        <p className="text-xs text-yellow-200">
                          <strong>Important:</strong> Copy this secret now! It won't be shown again.
                          Update your GitLab webhook settings with this new secret.
                        </p>
                      </div>
                    </>
                  ) : gitlabStatusData?.integration?.webhookSecret ? (
                    <>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm">
                          ••••••••••••••••
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleCopyWebhookSecret}
                          className="shrink-0"
                        >
                          {copiedWebhookSecret ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Use this secret token in your GitLab webhook configuration for security
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No webhook secret configured. Click regenerate to create one.
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRegenerateSecret}
                    disabled={regenerateSecretMutation.isPending}
                    className="mt-2"
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${regenerateSecretMutation.isPending ? 'animate-spin' : ''}`}
                    />
                    {regenerateSecretMutation.isPending ? 'Regenerating...' : 'Regenerate Secret'}
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    Lost your webhook secret? Regenerate it here and update your GitLab webhook
                    settings.
                  </p>
                </div>

                <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
                  <p className="text-sm text-blue-200">
                    <strong>Setup Instructions:</strong>
                  </p>
                  <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-blue-200/80">
                    <li>Go to your GitLab project → Settings → Webhooks</li>
                    <li>Paste the Webhook URL above</li>
                    <li>Add the Secret Token for security</li>
                    <li>Select "Merge request events" as the trigger</li>
                    <li>Click "Add webhook"</li>
                  </ol>
                </div>

                <a
                  href={`${gitlabStatusData?.integration?.instanceUrl || 'https://gitlab.com'}/-/profile/applications`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
                >
                  Open GitLab Settings
                  <ExternalLink className="h-3 w-3" />
                </a>
              </CardContent>
            </Card>
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
              <ReviewConfigForm platform="gitlab" />
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
