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
  compact?: boolean;
};

export function DevAddGitHubInstallationCard({
  organizationId,
  onSuccess,
  compact = false,
}: DevAddGitHubInstallationCardProps) {
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
          queryKey: trpc.githubApps.getInstallation.queryKey(
            organizationId ? { organizationId } : undefined
          ),
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

  if (process.env.NODE_ENV !== 'development') return null;

  if (compact) {
    return (
      <details className="group rounded-lg border border-status-warning-border bg-status-warning-surface">
        <summary className="type-label flex min-h-control-touch cursor-pointer list-none items-center gap-2 px-4 py-3 text-status-warning [&::-webkit-details-marker]:hidden">
          <Wrench className="size-4 text-status-warning-icon" />
          Test with an existing GitHub installation
          <span className="ml-auto text-muted-foreground transition-transform group-open:rotate-45">
            <Plus className="size-4" />
          </span>
        </summary>
        <form
          onSubmit={handleSubmit}
          className="space-y-4 border-t border-status-warning-border p-4"
        >
          <p className="type-label text-muted-foreground">
            Local GitHub callbacks cannot reach localhost. Import the installation from its GitHub
            settings URL to complete this wizard step.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="onboardingInstallationId">Installation ID</Label>
              <Input
                id="onboardingInstallationId"
                inputMode="numeric"
                placeholder="12345678"
                value={installationId}
                onChange={event => setInstallationId(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="onboardingAccountLogin">GitHub organization</Label>
              <Input
                id="onboardingAccountLogin"
                placeholder="my-organization"
                value={accountLogin}
                onChange={event => setAccountLogin(event.target.value)}
                required
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="outline"
              disabled={addInstallationMutation.isPending || !installationId || !accountLogin}
            >
              <Plus className="size-4" />
              {addInstallationMutation.isPending ? 'Importing…' : 'Import installation'}
            </Button>
            <span className="type-label text-muted-foreground">
              ID is the number in `github.com/settings/installations/ID`.
            </span>
          </div>
        </form>
      </details>
    );
  }

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
