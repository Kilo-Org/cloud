'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CheckCircle2, XCircle, Database } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthConnectPath } from '@/lib/integrations/oauth/paths';

type DoltHubIntegrationDetailsProps = {
  organizationId?: string;
  success?: boolean;
  error?: string;
};

export function DoltHubIntegrationDetails({
  organizationId,
  success,
  error,
}: DoltHubIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = organizationId ? { organizationId } : undefined;

  const {
    data: installationData,
    isLoading,
    refetch,
  } = useQuery(trpc.dolthub.getInstallation.queryOptions(input));

  const [isStartingConnection, setIsStartingConnection] = useState(false);

  const disconnect = useMutation(
    trpc.dolthub.disconnect.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.dolthub.getInstallation.queryKey(input),
        });
      },
    })
  );

  useEffect(() => {
    if (success) {
      toast.success('DoltHub connected successfully!');
    }
    if (error) {
      toast.error(`Connection failed: ${error}`);
    }
  }, [success, error]);

  const handleConnect = () => {
    setIsStartingConnection(true);
    window.location.href = getPlatformOAuthConnectPath(PLATFORM.DOLTHUB, organizationId);
  };

  const handleDisconnect = () => {
    if (confirm('Are you sure you want to disconnect DoltHub?')) {
      disconnect.mutate(input, {
        onSuccess: async () => {
          toast.success('DoltHub disconnected');
          await refetch();
        },
        onError: err => {
          toast.error('Failed to disconnect DoltHub', {
            description: err.message,
          });
        },
      });
    }
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
      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Could not connect DoltHub</AlertTitle>
          <AlertDescription>Connection failed: {error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                DoltHub Integration
              </CardTitle>
              <CardDescription>
                Query Dolt-versioned data directly from your workspace
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
          {installation ? (
            <>
              <div className="space-y-3 rounded-lg border p-4">
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

              <div className="space-y-2">
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="destructive"
                    onClick={handleDisconnect}
                    disabled={disconnect.isPending}
                  >
                    {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Connect DoltHub to query versioned data directly from your workspace.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What you&apos;ll get:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>✓ Query Dolt-versioned databases from your workspace</li>
                  <li>✓ Direct integration with DoltHub repositories</li>
                </ul>
              </div>

              <Button
                onClick={handleConnect}
                size="lg"
                className="w-full"
                disabled={isStartingConnection}
              >
                <Database className="mr-2 h-4 w-4" />
                {isStartingConnection ? 'Loading...' : 'Connect DoltHub'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
