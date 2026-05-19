'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  MessageSquareText,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';

type TeamsIntegrationDetailsProps = {
  organizationId?: string;
  success?: boolean;
  error?: string;
};

const teamsConnectionErrorMessages: Record<string, string> = {
  tenant_already_connected:
    'This Teams tenant is already connected to another Kilo account or organization. Disconnect it there before connecting it here.',
};

function getTeamsConnectionErrorMessage(error: string): string {
  return teamsConnectionErrorMessages[error] ?? `Connection failed: ${error}`;
}

export function TeamsIntegrationDetails({
  organizationId,
  success,
  error,
}: TeamsIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  const {
    data: installationData,
    isLoading,
    refetch,
  } = useQuery(trpc.teams.getInstallation.queryOptions(input));

  const { data: setupInfo } = useQuery(trpc.teams.getSetupInfo.queryOptions(input));

  const { data: openRouterModels, isLoading: isLoadingModels } =
    useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return openRouterModels?.data.map(model => ({ id: model.id, name: model.name })) ?? [];
  }, [openRouterModels]);

  const [selectedModel, setSelectedModel] = useState<string>('');
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [devRemoveDialogOpen, setDevRemoveDialogOpen] = useState(false);

  useEffect(() => {
    if (installationData?.installation?.modelSlug) {
      setSelectedModel(installationData.installation.modelSlug);
    }
  }, [installationData?.installation?.modelSlug]);

  const uninstallApp = useMutation(
    trpc.teams.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.teams.getInstallation.queryKey(input),
        });
      },
    })
  );

  const updateModel = useMutation(
    trpc.teams.updateModel.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.teams.getInstallation.queryKey(input),
        });
      },
    })
  );

  const devRemoveDbRowOnly = useMutation(
    trpc.teams.devRemoveDbRowOnly.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.teams.getInstallation.queryKey(input),
        });
      },
    })
  );

  useEffect(() => {
    if (success) toast.success('Teams connected successfully!');
    if (error) toast.error(getTeamsConnectionErrorMessage(error));
  }, [success, error]);

  const handleOpenInstallUrl = () => {
    if (!setupInfo?.installUrl) return;
    window.open(setupInfo.installUrl, '_blank', 'noopener,noreferrer');
  };

  const handleUninstall = () => {
    uninstallApp.mutate(input, {
      onSuccess: async () => {
        setDisconnectDialogOpen(false);
        toast.success('Teams disconnected');
        await refetch();
      },
      onError: err => {
        toast.error('Failed to disconnect Teams', { description: err.message });
      },
    });
  };

  const handleDevRemoveDbRowOnly = () => {
    devRemoveDbRowOnly.mutate(input, {
      onSuccess: async () => {
        setDevRemoveDialogOpen(false);
        toast.success('Database row removed (Teams app still installed)');
        await refetch();
      },
      onError: err => {
        toast.error('Failed to remove database row', { description: err.message });
      },
    });
  };

  const handleModelChange = (modelSlug: string) => {
    const previousModel = selectedModel;
    setSelectedModel(modelSlug);
    updateModel.mutate(
      { modelSlug, organizationId },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Model updated successfully');
          } else {
            setSelectedModel(previousModel);
            toast.error('Failed to update model', { description: result.error });
          }
        },
        onError: err => {
          setSelectedModel(previousModel);
          toast.error('Failed to update model', { description: err.message });
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
          <AlertTitle>Could not connect Teams</AlertTitle>
          <AlertDescription>{getTeamsConnectionErrorMessage(error)}</AlertDescription>
        </Alert>
      )}

      {setupInfo?.configured === false && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Teams credentials are not configured</AlertTitle>
          <AlertDescription>
            Add the Teams app credentials in this environment before installing the Teams app. The
            webhook route is only registered when credentials are present.
          </AlertDescription>
        </Alert>
      )}

      {installation && isSuspended && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Teams integration suspended</AlertTitle>
          <AlertDescription>
            This Teams integration is suspended and will not receive Teams messages. Disconnect and
            reconnect Teams to restore the connection.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5" />
                Microsoft Teams integration
              </CardTitle>
              <CardDescription>
                Mention Kilo in Teams to start coding work from chats, channels, and threads
              </CardDescription>
            </div>
            {isSuspended ? (
              <Badge variant="destructive" className="flex w-fit items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Suspended
              </Badge>
            ) : isInstalled ? (
              <Badge variant="default" className="flex w-fit items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex w-fit items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not connected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {installation ? (
            <>
              <div className="space-y-3 rounded-lg border p-4">
                <div className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-4">
                  <span className="text-sm font-medium">Tenant</span>
                  <span className="min-w-0 break-words text-sm sm:text-right">
                    {installation.tenantName}
                  </span>
                </div>
                <div className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-4">
                  <span className="text-sm font-medium">Tenant ID</span>
                  <span className="text-muted-foreground min-w-0 break-all font-mono text-xs sm:text-right">
                    {installation.tenantId}
                  </span>
                </div>
                <div className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-4">
                  <span className="text-sm font-medium">Connected</span>
                  <span className="text-sm sm:text-right">
                    {installation.installedAt
                      ? new Date(installation.installedAt).toLocaleDateString()
                      : 'Unknown'}
                  </span>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <ModelCombobox
                  label="AI model"
                  helperText="Select the AI model to use when responding to Teams messages"
                  models={modelOptions}
                  value={selectedModel}
                  onValueChange={handleModelChange}
                  isLoading={isLoadingModels}
                  placeholder="Select a model"
                  disabled={updateModel.isPending}
                />
              </div>

              <div className="flex flex-wrap gap-3">
                {setupInfo?.installUrl && (
                  <Button variant="outline" onClick={handleOpenInstallUrl}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Teams install
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => setDisconnectDialogOpen(true)}
                  disabled={uninstallApp.isPending}
                >
                  {uninstallApp.isPending ? 'Disconnecting...' : 'Disconnect'}
                </Button>
                {IS_DEVELOPMENT && (
                  <Button
                    variant="outline"
                    onClick={() => setDevRemoveDialogOpen(true)}
                    disabled={devRemoveDbRowOnly.isPending}
                    title="Dev only: remove DB row without removing the Teams app"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {devRemoveDbRowOnly.isPending ? 'Removing...' : 'Dev: remove DB only'}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Teams setup has two parts: add the Kilo app in Microsoft Teams, then mention Kilo
                  in Teams to choose the Kilo account or organization that owns the tenant.
                </AlertDescription>
              </Alert>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <Badge variant="secondary" className="mb-3">
                    Step 1
                  </Badge>
                  <h4 className="mb-1 text-sm font-medium">Install the Teams app</h4>
                  <p className="text-sm text-muted-foreground">
                    Add Kilo to your Teams tenant. The messaging endpoint should point at the
                    webhook below.
                  </p>
                </div>
                <div className="rounded-lg border p-4">
                  <Badge variant="secondary" className="mb-3">
                    Step 2
                  </Badge>
                  <h4 className="mb-1 text-sm font-medium">Mention Kilo</h4>
                  <p className="text-sm text-muted-foreground">
                    Mention Kilo in a Teams chat or channel. Kilo will DM you a secure setup link
                    and continue your original message after setup.
                  </p>
                </div>
              </div>

              {setupInfo?.configured !== false && setupInfo?.webhookUrl && (
                <div className="space-y-2 rounded-lg border p-4">
                  <span className="text-sm font-medium">Teams messaging endpoint</span>
                  <code className="block overflow-x-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    {setupInfo.webhookUrl}
                  </code>
                </div>
              )}

              {setupInfo?.configured === false ? (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Configure TEAMS_APP_ID, TEAMS_APP_PASSWORD, and TEAMS_APP_TENANT_ID for
                      SingleTenant apps, then restart the web server.
                    </p>
                  </div>
                </div>
              ) : setupInfo?.installUrl ? (
                <Button onClick={handleOpenInstallUrl} size="lg" className="w-full">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open Teams install
                </Button>
              ) : (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start gap-3">
                    <RefreshCw className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      No Teams install URL is configured yet. Use the Teams app manifest or app
                      catalog entry for this environment, then mention Kilo in Teams to complete
                      setup.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Teams?</AlertDialogTitle>
            <AlertDialogDescription>
              Kilo will stop responding to Teams messages for this tenant and remove linked Teams
              users from the bot cache.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstallApp.isPending}>
              Keep Teams connected
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleUninstall}
              disabled={uninstallApp.isPending}
            >
              {uninstallApp.isPending ? 'Disconnecting...' : 'Disconnect Teams'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={devRemoveDialogOpen} onOpenChange={setDevRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Teams database row?</AlertDialogTitle>
            <AlertDialogDescription>
              This development-only action removes the Kilo database row but keeps the Teams app
              installed in Microsoft Teams.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={devRemoveDbRowOnly.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDevRemoveDbRowOnly}
              disabled={devRemoveDbRowOnly.isPending}
            >
              {devRemoveDbRowOnly.isPending ? 'Removing...' : 'Remove DB row'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
