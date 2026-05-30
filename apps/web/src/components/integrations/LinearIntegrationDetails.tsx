'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CheckCircle2, XCircle, Trash2, RefreshCw, AlertTriangle, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthConnectPath } from '@/lib/integrations/oauth/paths';

type LinearIntegrationDetailsProps = {
  organizationId?: string;
  success?: boolean;
  error?: string;
};

const linearConnectionErrorMessages: Record<string, string> = {
  workspace_already_connected:
    'This Linear workspace is already connected to another Kilo account or organization. Disconnect it there before connecting it here.',
};

function getLinearConnectionErrorMessage(error: string): string {
  return linearConnectionErrorMessages[error] ?? `Connection failed: ${error}`;
}

export function LinearIntegrationDetails({
  organizationId,
  success,
  error,
}: LinearIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  const {
    data: installationData,
    isLoading,
    refetch,
  } = useQuery(trpc.linear.getInstallation.queryOptions(input));

  const { data: openRouterModels, isLoading: isLoadingModels } =
    useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return (
      openRouterModels?.data.map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
      })) ?? []
    );
  }, [openRouterModels]);

  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isStartingLinearConnection, setIsStartingLinearConnection] = useState(false);

  useEffect(() => {
    if (installationData?.installation?.modelSlug) {
      setSelectedModel(installationData.installation.modelSlug);
    }
  }, [installationData?.installation?.modelSlug]);

  const uninstallApp = useMutation(
    trpc.linear.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.linear.getInstallation.queryKey(input),
        });
      },
    })
  );

  const updateModel = useMutation(
    trpc.linear.updateModel.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.linear.getInstallation.queryKey(input),
        });
      },
    })
  );

  const devRemoveDbRowOnly = useMutation(
    trpc.linear.devRemoveDbRowOnly.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.linear.getInstallation.queryKey(input),
        });
      },
    })
  );

  useEffect(() => {
    if (success) {
      toast.success('Linear connected successfully!');
    }
    if (error) {
      toast.error(getLinearConnectionErrorMessage(error));
    }
  }, [success, error]);

  const handleInstall = () => {
    setIsStartingLinearConnection(true);
    window.location.href = getPlatformOAuthConnectPath(PLATFORM.LINEAR, organizationId);
  };

  const handleUninstall = () => {
    if (confirm('Are you sure you want to disconnect Linear?')) {
      uninstallApp.mutate(input, {
        onSuccess: async () => {
          toast.success('Linear disconnected');
          await refetch();
        },
        onError: err => {
          toast.error('Failed to disconnect Linear', {
            description: err.message,
          });
        },
      });
    }
  };

  const handleDevRemoveDbRowOnly = () => {
    if (
      confirm('This will remove the database row but keep the Linear app installed. Are you sure?')
    ) {
      devRemoveDbRowOnly.mutate(input, {
        onSuccess: async () => {
          toast.success('Database row removed (Linear app still installed)');
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
  const isSuspended = installation?.status === 'suspended';

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Could not connect Linear</AlertTitle>
          <AlertDescription>{getLinearConnectionErrorMessage(error)}</AlertDescription>
        </Alert>
      )}

      {installation && isSuspended && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Linear integration suspended</AlertTitle>
          <AlertDescription className="gap-3">
            <p>
              This Linear integration is suspended and will not receive Linear events. Re-install
              Linear to restore the connection.
            </p>
            <Button
              onClick={handleInstall}
              disabled={isStartingLinearConnection}
              className="bg-yellow-400 text-yellow-950 hover:bg-yellow-300"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {isStartingLinearConnection ? 'Loading...' : 'Re-install Linear'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Linear Integration
              </CardTitle>
              <CardDescription>
                Mention Kilo on a Linear issue to kick off an agent session right from your
                workspace
              </CardDescription>
            </div>
            {isSuspended ? (
              <Badge variant="destructive" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Suspended
              </Badge>
            ) : isInstalled ? (
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
          {installation ? (
            <>
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Workspace:</span>
                  <span className="text-sm">{installation.workspaceName}</span>
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

              <div className="space-y-3 rounded-lg border p-4">
                <ModelCombobox
                  label="AI Model"
                  helperText="Select the AI model to use when responding to Linear issues"
                  models={modelOptions}
                  value={selectedModel}
                  onValueChange={handleModelChange}
                  isLoading={isLoadingModels}
                  placeholder="Select a model"
                />
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    onClick={handleInstall}
                    disabled={isStartingLinearConnection}
                    title="Re-run the Linear OAuth flow to refresh scopes and permissions"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {isStartingLinearConnection ? 'Loading...' : 'Re-install'}
                  </Button>
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
                      title="Dev only: Remove DB row without revoking Linear token"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {devRemoveDbRowOnly.isPending ? 'Removing...' : 'Dev: Remove DB Only'}
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Connect Linear to have Kilo respond to @-mentions on issues and comments.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What you&apos;ll get:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>✓ Mention Kilo on a Linear issue to start an agent session</li>
                  <li>✓ Streaming replies with typing indicators</li>
                </ul>
              </div>

              <Button
                onClick={handleInstall}
                size="lg"
                className="w-full"
                disabled={isStartingLinearConnection}
              >
                <Zap className="mr-2 h-4 w-4" />
                {isStartingLinearConnection ? 'Loading...' : 'Connect Linear'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
