'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  CheckCircle2,
  XCircle,
  MessageSquare,
  Settings,
  ExternalLink,
  Send,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useMemo, useState } from 'react';
import { useSlackQueries } from './SlackContext';
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
  const { queries, mutations } = useSlackQueries();

  // Fetch Slack installation status
  const { data: installationData, isLoading, refetch } = queries.getInstallation();

  // Get OAuth URL for installation
  const { data: oauthUrlData } = queries.getOAuthUrl();

  // Fetch models for the model selector
  const { data: openRouterModels, isLoading: isLoadingModels } =
    useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return openRouterModels?.data.map(model => ({ id: model.id, name: model.name })) ?? [];
  }, [openRouterModels]);

  // Track selected model
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Initialize selected model from installation data
  useEffect(() => {
    if (installationData?.installation?.modelSlug) {
      setSelectedModel(installationData.installation.modelSlug);
    }
  }, [installationData?.installation?.modelSlug]);

  // Show success/error toasts
  useEffect(() => {
    if (success) {
      toast.success('Slack connected successfully!');
    }
    if (error) {
      toast.error(`Connection failed: ${error}`);
    }
  }, [success, error]);

  const handleInstall = () => {
    if (oauthUrlData?.url) {
      window.location.href = oauthUrlData.url;
    }
  };

  const handleUninstall = () => {
    if (confirm('Are you sure you want to disconnect Slack?')) {
      mutations.uninstallApp.mutate(undefined, {
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
      mutations.devRemoveDbRowOnly?.mutate(undefined, {
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
    mutations.testConnection.mutate(undefined, {
      onSuccess: result => {
        if (result.success) {
          toast.success('Connection test successful!');
        } else {
          toast.error('Connection test failed', {
            description: result.error,
          });
        }
      },
      onError: err => {
        toast.error('Connection test failed', {
          description: err.message,
        });
      },
    });
  };

  const handleSendTestMessage = () => {
    mutations.sendTestMessage.mutate(undefined, {
      onSuccess: result => {
        if (result.success) {
          toast.success('Test message sent!', {
            description: 'Check your Slack workspace for the message.',
          });
        } else {
          toast.error('Failed to send test message', {
            description: result.error,
          });
        }
      },
      onError: err => {
        toast.error('Failed to send test message', {
          description: err.message,
        });
      },
    });
  };

  const handleModelChange = (modelSlug: string) => {
    setSelectedModel(modelSlug);
    mutations.updateModel.mutate(
      { modelSlug },
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
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={mutations.testConnection.isPending}
                >
                  {mutations.testConnection.isPending ? 'Testing...' : 'Test Connection'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSendTestMessage}
                  disabled={mutations.sendTestMessage.isPending}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {mutations.sendTestMessage.isPending ? 'Sending...' : 'Send Test Message'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    window.open('https://slack.com/apps/manage', '_blank');
                  }}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Manage in Slack
                  <ExternalLink className="ml-2 h-3 w-3" />
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleUninstall}
                  disabled={mutations.uninstallApp.isPending}
                >
                  {mutations.uninstallApp.isPending ? 'Disconnecting...' : 'Disconnect'}
                </Button>
                {IS_DEVELOPMENT && (
                  <Button
                    variant="outline"
                    onClick={handleDevRemoveDbRowOnly}
                    disabled={mutations.devRemoveDbRowOnly.isPending}
                    className="border-yellow-500 text-yellow-500 hover:bg-yellow-500/10"
                    title="Dev only: Remove DB row without revoking Slack token"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {mutations.devRemoveDbRowOnly.isPending ? 'Removing...' : 'Dev: Remove DB Only'}
                  </Button>
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

              <Button onClick={handleInstall} size="lg" className="w-full">
                <MessageSquare className="mr-2 h-4 w-4" />
                Connect Slack
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
