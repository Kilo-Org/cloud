'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, XCircle, GitBranch, Settings, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { DevAddGitHubInstallationCard } from './DevAddGitHubInstallationCard';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';

type GitHubIntegrationDetailsProps = {
  organizationId?: string;
  organizationName?: string;
  success?: boolean;
  error?: string;
  pendingApproval?: boolean;
  existingPendingOrg?: string;
};

export function GitHubIntegrationDetails({
  organizationId,
  success,
  error,
  pendingApproval,
  existingPendingOrg,
}: GitHubIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  // Fetch organization data to check GitHub app type
  const { data: organizationData } = useOrganizationWithMembers(organizationId ?? '', {
    enabled: !!organizationId,
  });

  // Determine which GitHub App to use based on organization settings
  const githubAppName = useMemo(() => {
    const isLiteApp = organizationData?.settings?.github_app_type === 'lite';
    if (isLiteApp) {
      return process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite';
    }
    return process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
  }, [organizationData?.settings?.github_app_type]);

  // Fetch GitHub App installation status
  const {
    data: installationData,
    isLoading,
    refetch,
  } = useQuery(trpc.githubApps.getInstallation.queryOptions(input));

  // Check if user has pending installation in another org
  const { data: pendingCheck } = useQuery(
    trpc.githubApps.checkUserPendingInstallation.queryOptions(input)
  );

  const uninstallApp = useMutation(
    trpc.githubApps.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(input),
        });
      },
    })
  );

  const cancelPendingInstallation = useMutation(
    trpc.githubApps.cancelPendingInstallation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.checkUserPendingInstallation.queryKey(input),
        });
      },
    })
  );

  const refreshInstallation = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(input),
        });
      },
    })
  );

  // Show success/error/pending toasts
  useEffect(() => {
    if (success) {
      toast.success('GitHub App installed successfully!');
    }
    if (pendingApproval) {
      toast.info('Installation pending admin approval');
    }
    if (error === 'pending_installation_exists' && existingPendingOrg) {
      toast.error('Cannot create installation request', {
        description: `You already have a pending GitHub installation in another organization. Please complete or cancel that installation first.`,
        duration: 8000,
      });
    } else if (error) {
      toast.error(`Installation failed: ${error}`);
    }
  }, [success, error, pendingApproval, existingPendingOrg]);

  const { data: user } = useUser();

  const handleInstall = () => {
    const state = organizationId ? `org_${organizationId}` : `user_${user?.id}`;
    const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${state}`;
    window.location.href = installUrl;
  };

  const handleUninstall = () => {
    if (confirm('Are you sure you want to uninstall the Kilo GitHub App?')) {
      uninstallApp.mutate(input, {
        onSuccess: async () => {
          toast.success('GitHub App uninstalled');
          await refetch();
        },
        onError: error => {
          toast.error('Failed to uninstall app', {
            description: error.message,
          });
        },
      });
    }
  };

  const handleCancelPending = () => {
    if (confirm('Are you sure you want to cancel this installation request?')) {
      cancelPendingInstallation.mutate(input, {
        onSuccess: async () => {
          toast.success('Installation request cancelled');
          await refetch();
        },
        onError: error => {
          toast.error('Failed to cancel installation request', {
            description: error.message,
          });
        },
      });
    }
  };

  const handleRefresh = () => {
    refreshInstallation.mutate(input, {
      onSuccess: async () => {
        toast.success('Installation details refreshed', {
          description: 'Permissions and repositories have been updated from GitHub.',
        });
        await refetch();
      },
      onError: error => {
        toast.error('Failed to refresh installation', {
          description: error.message,
        });
      },
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="animate-pulse space-y-4">
            <div className="bg-muted h-20 rounded" />
            <div className="bg-muted h-32 rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const isInstalled = installationData?.installed;
  const installation = installationData?.installation;
  const status = installation?.status;
  const isPendingApproval = status === 'awaiting_installation';

  return (
    <div className="space-y-6">
      {/* Pending Approval Alert */}
      {isPendingApproval && (
        <Alert>
          <AlertDescription>
            <div className="flex items-end justify-between gap-4">
              <div className="flex-1 space-y-3">
                <h4 className="font-medium">Installation Pending Admin Approval</h4>
                <p className="text-muted-foreground text-sm">
                  Your installation request has been submitted to the GitHub organization
                  administrators. You will receive a notification once an admin approves the
                  installation.
                </p>
                <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
                  <li>✓ Installation request submitted</li>
                  <li>⏳ Waiting for organization admin approval</li>
                </ul>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancelPending}
                disabled={cancelPendingInstallation.isPending}
                className="shrink-0"
              >
                {cancelPendingInstallation.isPending ? 'Cancelling...' : 'Cancel Request'}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Installation Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                Kilo Code GitHub App
              </CardTitle>
              <CardDescription>
                Integrate your GitHub repositories with Kilocode for AI-powered code reviews,
                deployments, and more
              </CardDescription>
            </div>
            {isInstalled && !isPendingApproval ? (
              <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Installed
              </Badge>
            ) : isPendingApproval ? (
              <Badge variant="secondary" className="flex items-center gap-1">
                Pending Approval
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not Installed
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isInstalled && installation && !isPendingApproval ? (
            <>
              {/* Installation Details */}
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Account:</span>
                  <span className="text-sm">{installation.accountLogin}</span>
                </div>
                {installation.accountType && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Account Type:</span>
                    <Badge variant="outline">{String(installation.accountType)}</Badge>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Repository Access:</span>
                  <Badge variant="outline">
                    {installation.repositorySelection === 'all' ? 'All Repositories' : 'Selected'}
                  </Badge>
                </div>
                {installation.repositories &&
                  Array.isArray(installation.repositories) &&
                  installation.repositories.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-sm font-medium">Selected Repositories:</span>
                      <div className="flex flex-wrap gap-2">
                        {installation.repositories.map(
                          (repo: { id: number; full_name: string }) => (
                            <Badge key={repo.id} variant="secondary">
                              {repo.full_name}
                            </Badge>
                          )
                        )}
                      </div>
                    </div>
                  )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Installed:</span>
                  <span className="text-sm">
                    {new Date(installation.installedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    window.open(
                      `https://github.com/apps/${githubAppName}/installations/${installation.installationId}`,
                      '_blank'
                    );
                  }}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Manage on GitHub
                  <ExternalLink className="ml-2 h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={refreshInstallation.isPending}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${refreshInstallation.isPending ? 'animate-spin' : ''}`}
                  />
                  {refreshInstallation.isPending ? 'Refreshing...' : 'Refresh Permissions'}
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleUninstall}
                  disabled={uninstallApp.isPending}
                >
                  {uninstallApp.isPending ? 'Uninstalling...' : 'Uninstall App'}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Not Installed State */}
              <Alert>
                <AlertDescription>
                  Install the Kilo GitHub App to integrate your repositories with Kilocode. Enable
                  AI-powered code reviews, automated deployments, and other intelligent workflows
                  for your projects.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What happens when you install:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>✓ Select which repositories to integrate with Kilocode</li>
                  <li>✓ Enable AI-powered code reviews on pull requests</li>
                  <li>✓ Set up automated deployment workflows</li>
                  <li>✓ Configure intelligent agents for your repositories</li>
                  <li>✓ Seamless integration with your existing GitHub workflows</li>
                </ul>
              </div>

              {!isPendingApproval && (
                <>
                  {pendingCheck?.hasPending &&
                  pendingCheck.pendingOrganizationId !== organizationId ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        <div className="space-y-2">
                          <p className="font-medium">
                            You already have a pending GitHub installation in another organization.
                            Please complete or cancel that installation before creating a new one.
                          </p>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Button onClick={handleInstall} size="lg" className="w-full">
                      <GitBranch className="mr-2 h-4 w-4" />
                      Install Kilo GitHub App
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Dev-only card for adding existing installations - only show when no app is installed */}
      {!isInstalled && (
        <DevAddGitHubInstallationCard organizationId={organizationId} onSuccess={() => refetch()} />
      )}
    </div>
  );
}
