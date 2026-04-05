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
    { label: 'Config', href: `${basePath}/config`, icon: Settings2 },
  ];

  // Refresh installation mutation (only used in layout for permission alert)
  const { mutate: refreshMutate, isPending: isRefreshing } = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('Permissions refreshed', {
          description: 'GitHub App permissions have been updated from GitHub.',
        });
        void queryClient.invalidateQueries();
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
          Monitor and manage Dependabot security alerts for your repositories
        </p>
        <a
          href="https://kilo.ai/docs/contributing/architecture/security-reviews"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* Sub-navigation — hidden when GitHub is not installed */}
      {hasIntegration && (
        <nav className="flex gap-1 border-b border-gray-800">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                  active
                    ? 'border-primary text-primary'
                    : 'text-muted-foreground hover:text-foreground border-transparent hover:border-gray-600'
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
          <AlertTitle>Additional Permissions Required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Security Agent requires the <code>vulnerability_alerts</code> permission to access
              Dependabot alerts. Please re-authorize the GitHub App to grant this permission.
            </p>
            <div className="flex flex-wrap gap-3">
              {reauthorizeUrl && (
                <Button asChild>
                  <a href={reauthorizeUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
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
                <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Refreshing...' : 'Refresh Permissions'}
              </Button>
            </div>
            <p className="text-sm opacity-80">
              Already approved the new permissions in GitHub? Click &quot;Refresh Permissions&quot;
              to update.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Page content */}
      {children}
    </div>
  );
}
