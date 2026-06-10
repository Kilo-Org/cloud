'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  LayoutDashboard,
  ListChecks,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSecurityAgent } from './SecurityAgentContext';

type SecurityAgentLayoutProps = {
  children: React.ReactNode;
};

export function SecurityAgentLayout({ children }: SecurityAgentLayoutProps) {
  const pathname = usePathname();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const {
    organizationId,
    isOrg,
    hasIntegration,
    hasPermission,
    isLoadingPermission,
    reauthorizeUrl,
  } = useSecurityAgent();

  const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';

  const navItems = [
    { label: 'Dashboard', href: basePath, icon: LayoutDashboard },
    { label: 'Findings', href: `${basePath}/findings`, icon: ListChecks },
    { label: 'Settings', href: `${basePath}/config`, icon: Settings2 },
  ];

  // Refresh installation mutation (only used in layout for permission alert)
  const { mutate: refreshMutate, isPending: isRefreshing } = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('Permissions refreshed', {
          description: 'GitHub App permissions have been updated from GitHub.',
        });
        const input = organizationId ? { organizationId } : undefined;
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(input),
        });
        if (isOrg && organizationId) {
          const ownerInput = { organizationId };
          void queryClient.invalidateQueries({
            queryKey: trpc.organizations.securityAgent.getPermissionStatus.queryKey(ownerInput),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.organizations.securityAgent.getRepositories.queryKey(ownerInput),
          });
        } else {
          void queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getPermissionStatus.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getRepositories.queryKey(),
          });
        }
      },
      onError: (error: { message: string }) => {
        toast.error('Failed to refresh permissions', { description: error.message });
      },
    })
  );

  const handleRefreshPermissions = () => {
    if (isOrg && organizationId) {
      refreshMutate({ organizationId });
    } else {
      refreshMutate(undefined);
    }
  };

  const showPermissionRequired = hasIntegration && !hasPermission && !isLoadingPermission;

  function isActive(href: string) {
    if (href === basePath) {
      return pathname === basePath;
    }
    return pathname.startsWith(href);
  }

  return (
    <div className="space-y-6">
      <SetPageTitle title="Security Agent">
        <Badge variant="beta">Beta</Badge>
      </SetPageTitle>
      {/* Header */}
      <div className="space-y-2">
        <p className="text-muted-foreground">
          Monitor and manage Dependabot security alerts across your repositories.
        </p>
        <a
          href="https://kilo.ai/docs/contributing/architecture/security-reviews"
          target="_blank"
          rel="noopener noreferrer"
          className="focus-visible:ring-ring mt-2 inline-flex items-center gap-1 rounded-sm text-sm text-blue-400 underline decoration-blue-400/40 underline-offset-4 transition-colors hover:text-blue-300 focus-visible:ring-2 focus-visible:outline-none"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* Sub-navigation — hidden when GitHub is not installed */}
      {hasIntegration && (
        <nav
          className="border-border flex gap-1 overflow-x-auto border-b"
          aria-label="Security Agent"
        >
          {navItems.map(item => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-ring flex shrink-0 items-center gap-2 rounded-t-md border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  active
                    ? 'border-brand-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent hover:border-border'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}

      {/* Additional Permissions Required Alert */}
      {showPermissionRequired && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Additional permissions required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Security Agent requires the <code>vulnerability_alerts</code> permission to access
              Dependabot alerts. Re-authorize GitHub App to grant this permission.
            </p>
            <div className="flex flex-wrap gap-3">
              {reauthorizeUrl && (
                <Button
                  asChild
                  className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90"
                >
                  <a href={reauthorizeUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" aria-hidden="true" />
                    Re-authorize GitHub App
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleRefreshPermissions}
                disabled={isRefreshing}
                className="border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <RefreshCw
                  className={`size-4 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
                  aria-hidden="true"
                />
                {isRefreshing ? 'Refreshing...' : 'Refresh permissions'}
              </Button>
            </div>
            <p className="text-sm opacity-80">
              Already approved permissions in GitHub? Refresh permissions to update Security Agent.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Page content */}
      {children}
    </div>
  );
}
