'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  CheckCircle2,
  XCircle,
  GitBranch,
  Settings,
  ExternalLink,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { DevAddGitHubInstallationCard } from './DevAddGitHubInstallationCard';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { buildGitHubInstallState } from './github-install-state';
import { useConfirm } from '@/components/ui/confirm';

type GitHubIntegrationDetailsProps = {
  organizationId?: string;
  success?: boolean;
  userConnectionSuccess?: boolean;
  error?: string;
  pendingApproval?: boolean;
  existingPendingOrg?: string;
  appReturnPath?: string;
  onInstallationDetected?: () => void;
};

export function GitHubIntegrationDetails({
  organizationId,
  success,
  userConnectionSuccess,
  error,
  pendingApproval,
  existingPendingOrg,
  appReturnPath,
  onInstallationDetected,
}: GitHubIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const input = organizationId ? { organizationId } : undefined;

  // Fetch organization data to check GitHub app type
  const { data: organizationData } = useOrganizationWithMembers(organizationId ?? '', {
    enabled: !!organizationId && !appReturnPath,
  });

  // Fetch models for the model selector
  const { data: openRouterModels, isLoading: isLoadingModels } = useModelSelectorList(
    organizationId,
    !appReturnPath
  );

  const modelOptions = useMemo<ModelOption[]>(() => {
    return (
      openRouterModels?.data.map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
      })) ?? []
    );
  }, [openRouterModels]);

  // Track selected model
  const [selectedModel, setSelectedModel] = useState<string>('');
  const installationDetectedRef = useRef(false);

  const { data: onboardingAppType } = useQuery({
    ...trpc.githubApps.getAppType.queryOptions(input),
    enabled: Boolean(appReturnPath),
  });

  // Determine which GitHub App to use based on organization settings
  const githubAppName = useMemo(() => {
    const isLiteApp = appReturnPath
      ? onboardingAppType === 'lite'
      : organizationData?.settings?.github_app_type === 'lite';
    if (isLiteApp) {
      return process.env.NEXT_PUBLIC_GITHUB_LITE_APP_NAME || 'KiloConnect-Lite';
    }
    return process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
  }, [appReturnPath, onboardingAppType, organizationData?.settings?.github_app_type]);

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

  const { data: userAuthorization } = useQuery({
    ...trpc.githubApps.getUserAuthorization.queryOptions(),
    enabled: !organizationId,
  });

  const connectUserAuthorization = useMutation(
    trpc.githubApps.connectUserAuthorization.mutationOptions({
      onSuccess: result => {
        window.location.href = result.authorizationUrl;
      },
    })
  );

  const disconnectUserAuthorization = useMutation(
    trpc.githubApps.disconnectUserAuthorization.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
        });
        toast.success('GitHub identity disconnected');
      },
    })
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

  const updateModel = useMutation(
    trpc.githubApps.updateModel.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
      },
    })
  );

  // Initialize selected model from installation data
  useEffect(() => {
    if (installationData?.installation?.modelSlug) {
      setSelectedModel(installationData.installation.modelSlug);
    }
  }, [installationData?.installation?.modelSlug]);

  useEffect(() => {
    if (!appReturnPath) return;

    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    };

    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [appReturnPath, refetch]);

  const isInstalled = installationData?.installed;
  useEffect(() => {
    if (!appReturnPath || !isInstalled || installationDetectedRef.current) return;
    installationDetectedRef.current = true;
    onInstallationDetected?.();
  }, [appReturnPath, isInstalled, onInstallationDetected]);

  // Show success/error/pending toasts
  useEffect(() => {
    if (success) {
      toast.success('GitHub App installed successfully!');
    }
    if (userConnectionSuccess) {
      toast.success('GitHub identity connected');
    }
    if (pendingApproval) {
      toast.info('Installation pending admin approval');
    }
    if (error === 'pending_installation_exists' && existingPendingOrg) {
      toast.error('Cannot create installation request', {
        description: `You already have a pending GitHub installation in another organization. Please complete or cancel that installation first.`,
        duration: 8000,
      });
    } else if (error === 'already_connected_to_another_account') {
      toast.error('This GitHub identity is already connected to another Kilo account.');
    } else if (error === 'disconnect_existing_identity_first') {
      toast.error('Disconnect your current GitHub identity before connecting another account.');
    } else if (error) {
      toast.error(`GitHub connection failed: ${error}`);
    }
  }, [success, userConnectionSuccess, error, pendingApproval, existingPendingOrg]);

  const { data: user } = useUser();

  const handleModelChange = (modelSlug: string) => {
    setSelectedModel(modelSlug);
    updateModel.mutate(
      { modelSlug, organizationId },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Model updated successfully');
          } else {
            toast.error('Failed to update model', {
              description: result.error,
            });
          }
        },
        onError: err => {
          toast.error('Failed to update model', {
            description: err.message,
          });
        },
      }
    );
  };

  const handleInstall = () => {
    const state = organizationId ? `org_${organizationId}` : `user_${user?.id}`;
    const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(buildGitHubInstallState(state, appReturnPath))}`;
    if (appReturnPath) {
      window.open(installUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    window.location.href = installUrl;
  };

  const handleConnectIdentity = () => {
    connectUserAuthorization.mutate(undefined, {
      onError: error => {
        toast.error('Failed to start GitHub connection', { description: error.message });
      },
    });
  };

  const handleDisconnectIdentity = async () => {
    if (
      await confirm({
        title: 'Disconnect your GitHub identity?',
        description: 'Kilo will no longer act on your behalf with your personal GitHub account.',
        confirmLabel: 'Disconnect',
        destructive: true,
      })
    ) {
      disconnectUserAuthorization.mutate(undefined, {
        onError: error => {
          toast.error('Failed to disconnect GitHub identity', { description: error.message });
        },
      });
    }
  };

  const handleUninstall = async () => {
    if (
      await confirm({
        title: 'Uninstall the Kilo GitHub App?',
        description: 'Kilo will lose access to your repositories until the app is reinstalled.',
        confirmLabel: 'Uninstall',
        destructive: true,
      })
    ) {
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

  const handleCancelPending = async () => {
    if (
      await confirm({
        title: 'Cancel this installation request?',
        description: 'The pending GitHub App installation request will be withdrawn.',
        confirmLabel: 'Cancel request',
        cancelLabel: 'Keep request',
        destructive: true,
      })
    ) {
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
    return appReturnPath ? (
      <div className="animate-pulse space-y-4 rounded-xl border border-border bg-surface-background p-6">
        <div className="h-5 w-40 rounded bg-surface-hover" />
        <div className="h-16 rounded-lg bg-surface-raised" />
        <div className="h-10 rounded-md bg-surface-hover" />
      </div>
    ) : (
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

  const installation = installationData?.installation;
  const status = installation?.status;
  const isPendingApproval = status === 'awaiting_installation';

  if (appReturnPath && !isInstalled && !isPendingApproval) {
    return (
      <section
        className="flex min-h-64 flex-col justify-between rounded-xl border border-border bg-surface-background p-6"
        aria-labelledby="github-onboarding-install-title"
      >
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <h2
                id="github-onboarding-install-title"
                className="type-heading flex items-center gap-2"
              >
                <GitBranch className="size-5 text-muted-foreground" />
                Install the Kilo GitHub App
              </h2>
              <p className="type-body max-w-xl text-muted-foreground">
                Choose the GitHub organization and repositories Kilo can access. GitHub opens in a
                new tab so this setup guide stays available.
              </p>
            </div>
            <Badge variant="secondary" className="shrink-0">
              Required
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['1', 'Choose an account'],
              ['2', 'Select repositories'],
              ['3', 'Approve access'],
            ].map(([number, label]) => (
              <div key={number} className="flex items-center gap-3 rounded-lg bg-surface-inset p-3">
                <span className="type-label flex size-6 shrink-0 items-center justify-center rounded-full border border-border tabular-nums text-muted-foreground">
                  {number}
                </span>
                <span className="type-label text-foreground">{label}</span>
              </div>
            ))}
          </div>

          {pendingCheck?.hasPending && pendingCheck.pendingOrganizationId !== organizationId && (
            <Alert variant="destructive">
              <AlertDescription>
                Complete or cancel your pending GitHub installation for another organization before
                starting this one.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="mt-8">
          <Button
            onClick={handleInstall}
            disabled={
              pendingCheck?.hasPending && pendingCheck.pendingOrganizationId !== organizationId
            }
          >
            Open GitHub setup
            <ExternalLink className="size-4" />
          </Button>
          <p className="type-label mt-3 text-muted-foreground">
            Complete setup in the new tab, then return here. This page checks your connection when
            you return.
          </p>
          <div className="mt-5">
            <DevAddGitHubInstallationCard
              organizationId={organizationId}
              compact
              onSuccess={() => void refetch()}
            />
          </div>
        </div>
      </section>
    );
  }

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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                {organizationId ? 'Kilo Code GitHub App' : 'Repository access'}
              </CardTitle>
              <CardDescription>
                {organizationId
                  ? 'Integrate your GitHub repositories with Kilo Code for code reviews, deployments, and more.'
                  : 'Required for personal repositories. Install the Kilo GitHub App and choose which repositories Kilo Code can access.'}
              </CardDescription>
            </div>
            {isInstalled && !isPendingApproval ? (
              <Badge variant="default" className="flex shrink-0 items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Installed
              </Badge>
            ) : isPendingApproval ? (
              <Badge variant="secondary" className="flex shrink-0 items-center gap-1">
                Pending approval
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex shrink-0 items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not installed
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

              {/* Model Selection */}
              <div className="space-y-3 rounded-lg border p-4">
                <ModelCombobox
                  label="AI Model"
                  helperText="Select the AI model to use when responding to GitHub bot mentions"
                  models={modelOptions}
                  value={selectedModel}
                  onValueChange={handleModelChange}
                  isLoading={isLoadingModels}
                  placeholder="Select a model"
                />
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
                  {organizationId
                    ? 'Install the Kilo GitHub App to give Kilo Code access to your organization repositories.'
                    : 'Install the Kilo GitHub App to give Kilo Code access to your personal repositories. Organization repositories may already be available through an organization installation.'}
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What repository access enables</h4>
                <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                  <li>Select which repositories Kilo Code can access</li>
                  <li>Run enabled code reviews on pull requests</li>
                  <li>Run configured deployment and agent workflows</li>
                  <li>Manage repository access later in GitHub settings</li>
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

      {!organizationId ? (
        <Card id="github-identity">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="flex items-center gap-2">
                    <UserRound className="h-5 w-5" />
                    Use your GitHub identity
                  </CardTitle>
                  <Badge variant="outline">Optional</Badge>
                </div>
                <CardDescription>
                  Connect your GitHub account so eligible Cloud Agent sessions can act as you in
                  repositories where the Kilo GitHub App is installed.
                </CardDescription>
              </div>
              {userAuthorization?.connected ? (
                <Badge variant="default" className="flex shrink-0 items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="secondary" className="shrink-0">
                  Not connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {userAuthorization?.revoked && (
              <Alert variant="destructive">
                <AlertDescription>
                  Your GitHub authorization is no longer valid. Reconnect your account to perform
                  eligible GitHub actions as yourself.
                </AlertDescription>
              </Alert>
            )}
            {userAuthorization?.githubLogin && (
              <div className="flex flex-col gap-1 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-muted-foreground text-sm">Connected account</span>
                <span className="font-mono text-sm">@{userAuthorization.githubLogin}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {!userAuthorization?.connected && (
                <Button
                  variant="outline"
                  onClick={handleConnectIdentity}
                  disabled={connectUserAuthorization.isPending}
                >
                  {connectUserAuthorization.isPending
                    ? 'Connecting...'
                    : userAuthorization?.revoked
                      ? 'Reconnect GitHub account'
                      : 'Connect GitHub account'}
                </Button>
              )}
              {userAuthorization?.githubLogin && (
                <Button
                  variant="outline"
                  onClick={handleDisconnectIdentity}
                  disabled={disconnectUserAuthorization.isPending}
                >
                  {disconnectUserAuthorization.isPending
                    ? 'Disconnecting...'
                    : 'Disconnect account'}
                </Button>
              )}
            </div>
            {userAuthorization?.connected && (
              <p className="text-muted-foreground text-sm">
                {isInstalled
                  ? 'Eligible Cloud Agent sessions can use your GitHub identity instead of the Kilo bot.'
                  : 'To act as you, Cloud Agent also needs repository access from an installed Kilo GitHub App, either for your repository or through an organization.'}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        !appReturnPath && (
          <Card>
            <CardHeader>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="flex items-center gap-2">
                    <UserRound className="h-5 w-5" />
                    Use your GitHub identity
                  </CardTitle>
                  <Badge variant="outline">Optional</Badge>
                </div>
                <CardDescription>
                  Your GitHub identity is personal, not owned by this organization. Manage it from
                  your personal integration to let eligible Cloud Agent sessions act as you where
                  supported repository access is available.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href="/integrations/github#github-identity">Manage GitHub identity</Link>
              </Button>
            </CardContent>
          </Card>
        )
      )}

      {/* Dev-only card for adding existing installations - only show when no app is installed */}
      {!isInstalled && !appReturnPath && (
        <DevAddGitHubInstallationCard organizationId={organizationId} onSuccess={refetch} />
      )}
    </div>
  );
}
