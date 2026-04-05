'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Wrench, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';

type DevAddGitHubInstallationCardProps = {
  organizationId?: string;
  onSuccess?: () => void;
};

export function DevAddGitHubInstallationCard({
  organizationId,
  onSuccess,
}: DevAddGitHubInstallationCardProps) {
  // Only render in development mode

  if (process.env.NODE_ENV !== 'development') return null;

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [installationId, setInstallationId] = useState('93545927');
  const [accountLogin, setAccountLogin] = useState('Kilo-Org');

  const addInstallationMutation = useMutation(
    trpc.githubApps.devAddInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('GitHub installation added successfully!');
        setInstallationId('93545927');
        setAccountLogin('Kilo-Org');
        // Invalidate queries to refresh the installation status
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(),
        });
        onSuccess?.();
      },
      onError: error => {
        toast.error('Failed to add installation', {
          description: error.message,
        });
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!installationId || !accountLogin) {
      toast.error('Installation ID and Account Login are required');
      return;
    }

    addInstallationMutation.mutate({
      organizationId,
      installationId,
      accountLogin,
    });
  };

  const githubAppName = process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';

  return (
    <Card className="border-yellow-600 bg-yellow-950/20">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-yellow-500" />
          <CardTitle className="text-yellow-500">
            Dev: Add Existing GitHub Installation ({githubAppName})
          </CardTitle>
        </div>
        <CardDescription>
          Manually add a GitHub App installation that was set up outside of local development or
          after a database reset. Find the installation ID in your GitHub App settings URL.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert className="mb-4 border-yellow-600/50 bg-yellow-950/30">
          <AlertDescription className="text-yellow-200/80">
            <strong>How to find your Installation ID:</strong>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm">
              <li>
                Go to GitHub → Settings → Applications → Installed GitHub Apps → Configure (on Kilo
                Code app)
              </li>
              <li>
                The URL will be:{' '}
                <code className="rounded bg-yellow-900/50 px-1">
                  github.com/settings/installations/INSTALLATION_ID
                </code>
              </li>
              <li>Copy the numeric ID from the URL</li>
            </ol>
          </AlertDescription>
        </Alert>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="installationId">Installation ID *</Label>
              <Input
                id="installationId"
                type="text"
                placeholder="e.g., 12345678"
                value={installationId}
                onChange={e => setInstallationId(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="accountLogin">GitHub Account/Org Name *</Label>
              <Input
                id="accountLogin"
                type="text"
                placeholder="e.g., my-org or my-username"
                value={accountLogin}
                onChange={e => setAccountLogin(e.target.value)}
                required
              />
            </div>
          </div>

          <Button
            type="submit"
            disabled={addInstallationMutation.isPending || !installationId || !accountLogin}
            className="w-full"
          >
            <Plus className="mr-2 h-4 w-4" />
            {addInstallationMutation.isPending ? 'Adding...' : 'Add Existing Installation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
