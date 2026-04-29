'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, XCircle, MessageSquare, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';

type SlackIntegrationDetailsProps = {
  organizationId?: string;
  success?: boolean;
  error?: string;
};

export function SlackIntegrationDetails({
  organizationId,
  success,
  error,
}: SlackIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  // Fetch Slack installation status
  const {
    data: installationData,
    isLoading,
    refetch,
  } = useQuery(trpc.slack.getInstallation.queryOptions(input));

  // Get OAuth URL only when the user clicks Connect so the signed state is fresh.
  const { refetch: refetchOAuthUrl, isFetching: isFetchingOAuthUrl } = useQuery(
    trpc.slack.getOAuthUrl.queryOptions(input, { enabled: false })
  );

  // Fetch models for the model selector
  const { data: openRouterModels, isLoading: isLoadingModels } =
    useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return openRouterModels?.data.map(model => ({ id: model.id, name: model.name })) ?? [];
  }, [openRouterModels]);

  // Track selected model
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isStartingSlackConnection, setIsStartingSlackConnection] = useState(false);

  type ConnectionCheckState =
    | { status: 'idle' }
    | { status: 'success' }
    | { status: 'error'; message: string };
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheckState>({ status: 'idle' });

  // Initialize selected model from installation data
  useEffect(() => {
    if (installationData?.installation?.modelSlug) {
      setSelectedModel(installationData.installation.modelSlug);
    }
  }, [installationData?.installation?.modelSlug]);

  // Reset the connection check state when the installation disappears
  useEffect(() => {
    if (!installationData?.installed) {
      setConnectionCheck({ status: 'idle' });
    }
  }, [installationData?.installed]);

  // Auto-reset the success state to idle after 30 seconds so the button
  // becomes actionable again.
  useEffect(() => {
    if (connectionCheck.status !== 'success') return;
    const timer = setTimeout(() => {
      setConnectionCheck({ status: 'idle' });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [connectionCheck.status]);

  const uninstallApp = useMutation(
    trpc.slack.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.slack.getInstallation.queryKey(input),
        });
      },
    })
  );

  const testConnection = useMutation(trpc.slack.testConnection.mutationOptions());

  const updateModel = useMutation(
    trpc.slack.updateModel.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.slack.getInstallation.queryKey(input),
        });
      },
    })
  );

  const devRemoveDbRowOnly = useMutation(
    trpc.slack.devRemoveDbRowOnly.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.slack.getInstallation.queryKey(input),
        });
      },
    })
  );

  // Show success/error toasts
  useEffect(() => {
    if (success) {
      toast.success('Slack connected successfully!');
    }
    if (error) {
      toast.error(`Connection failed: ${error}`);
    }
  }, [success, error]);

  const handleInstall = async () => {
    setIsStartingSlackConnection(true);
    const result = await refetchOAuthUrl();
    if (result.data?.url) {
      window.location.href = result.data.url;
    } else if (result.error) {
      setIsStartingSlackConnection(false);
      toast.error('Failed to start Slack connection', {
        description: result.error.message,
      });
    } else {
      setIsStartingSlackConnection(false);
    }
  };

  const handleUninstall = () => {
    if (confirm('Are you sure you want to disconnect Slack?')) {
      uninstallApp.mutate(input, {
        onSuccess: async () => {
          toast.success('Slack disconnected');
          await refetch();
        },
        onError: err => {
          toast.error('Failed to disconnect Slack', {
            description: err.message,
          });
        },
      });
    }
  };

  const handleDevRemoveDbRowOnly = () => {
    if (
      confirm('This will remove the database row but keep the Slack app installed. Are you sure?')
    ) {
      devRemoveDbRowOnly.mutate(input, {
        onSuccess: async () => {
          toast.success('Database row removed (Slack app still installed)');
          await refetch();
        },
        onError: err => {
          toast.error('Failed to remove database row', {
            description: err.message,
          });
        },
      });
    }
  };

  const handleTestConnection = () => {
    testConnection.mutate(input, {
      onSuccess: result => {
        if (result.success) {
          setConnectionCheck({ status: 'success' });
        } else if ('error' in result && result.error) {
          setConnectionCheck({
            status: 'error',
            message: result.error,
          });
        }
      },
      onError: err => {
        setConnectionCheck({
          status: 'error',
          message: err.message,
        });
      },
    });
  };

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

  return (
    <div className="space-y-6">
      {/* Installation Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Slack Integration
              </CardTitle>
              <CardDescription>
                Create PRs, debug code, ask questions about your repos, etc. directly from Slack
              </CardDescription>
            </div>
            {isInstalled ? (
              <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not Connected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isInstalled && installation ? (
            <>
              {/* Installation Details */}
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Workspace:</span>
                  <span className="text-sm">{installation.teamName}</span>
                </div>
                {installation.scopes && installation.scopes.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-sm font-medium">Permissions:</span>
                    <div className="flex flex-wrap gap-2">
                      {installation.scopes.map((scope: string) => (
                        <Badge key={scope} variant="secondary" className="text-xs">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Connected:</span>
                  <span className="text-sm">
                    {installation.installedAt
                      ? new Date(installation.installedAt).toLocaleDateString()
                      : 'Unknown'}
                  </span>
                </div>
              </div>

              {/* Model Selection */}
              <div className="space-y-3 rounded-lg border p-4">
                <ModelCombobox
                  label="AI Model"
                  helperText="Select the AI model to use when responding to Slack messages"
                  models={modelOptions}
                  value={selectedModel}
                  onValueChange={handleModelChange}
                  isLoading={isLoadingModels}
                  placeholder="Select a model"
                />
              </div>

              {/* Actions */}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-3">
                  <TestConnectionButton
                    isPending={testConnection.isPending}
                    state={connectionCheck}
                    onClick={handleTestConnection}
                  />
                  <Button
                    variant="destructive"
                    onClick={handleUninstall}
                    disabled={uninstallApp.isPending}
                  >
                    {uninstallApp.isPending ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                  {IS_DEVELOPMENT && (
                    <Button
                      variant="outline"
                      onClick={handleDevRemoveDbRowOnly}
                      disabled={devRemoveDbRowOnly.isPending}
                      className="border-yellow-500 text-yellow-500 hover:bg-yellow-500/10"
                      title="Dev only: Remove DB row without revoking Slack token"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {devRemoveDbRowOnly.isPending ? 'Removing...' : 'Dev: Remove DB Only'}
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  This verifies Kilo can authenticate with Slack. To use Kilo in a channel, invite
                  or mention Kilo in Slack.
                </p>
                {connectionCheck.status === 'success' && (
                  <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" />
                    Slack authorization is valid.
                  </p>
                )}
                {connectionCheck.status === 'error' && (
                  <p className="text-destructive flex items-center gap-2 text-sm">
                    <XCircle className="h-4 w-4" />
                    {connectionCheck.message}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Not Connected State */}
              <Alert>
                <AlertDescription>
                  Connect Slack to talk with Kilo directly from your workspace.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What you&apos;ll get:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>✓ Message Kilo directly from Slack</li>
                </ul>
              </div>

              <Button
                onClick={handleInstall}
                size="lg"
                className="w-full"
                disabled={isStartingSlackConnection || isFetchingOAuthUrl}
              >
                <MessageSquare className="mr-2 h-4 w-4" />
                {isStartingSlackConnection || isFetchingOAuthUrl ? 'Loading...' : 'Connect Slack'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type TestConnectionButtonProps = {
  isPending: boolean;
  state: { status: 'idle' | 'success' } | { status: 'error'; message: string };
  onClick: () => void;
};

function TestConnectionButton({ isPending, state, onClick }: TestConnectionButtonProps) {
  if (isPending) {
    return (
      <Button variant="outline" disabled>
        Testing...
      </Button>
    );
  }

  if (state.status === 'success') {
    return (
      <Button
        variant="outline"
        disabled
        className="border-green-600/50 text-green-600 disabled:opacity-100 dark:border-green-400/50 dark:text-green-400"
      >
        <CheckCircle2 className="mr-2 h-4 w-4" />
        Connection OK
      </Button>
    );
  }

  if (state.status === 'error') {
    return (
      <Button
        variant="outline"
        onClick={onClick}
        className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <XCircle className="mr-2 h-4 w-4" />
        Connection Failed
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={onClick}>
      Test Connection
    </Button>
  );
}
