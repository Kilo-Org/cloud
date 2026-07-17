import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { DashboardScreen } from '@/components/security-agent/dashboard-screen';
import { SecurityAgentSetup } from '@/components/security-agent/security-agent-setup';
import { Skeleton } from '@/components/ui/skeleton';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import {
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentPermissionStatus,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';
import { getSecurityAgentPath } from '@/lib/security-agent';

function ScopeEntrySkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Security Agent" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <View className="flex-row flex-wrap gap-3">
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
        </View>
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function ScopeEntryScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const permission = useSecurityAgentPermissionStatus(scope);
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const capability = useSecurityAgentCapability(scope);

  const isLoading = permission.isLoading || config.isLoading || capability.isLoading;
  const isError = permission.isError || config.isError || capability.isError;

  const hasIntegration = permission.data?.hasIntegration ?? false;
  const hasPermissions = permission.data?.hasPermissions ?? false;
  const isEnabled = config.data?.isEnabled ?? false;
  const isDisabled = !isLoading && !isError && hasIntegration && hasPermissions && !isEnabled;

  useEffect(() => {
    if (isDisabled) {
      router.replace(getSecurityAgentPath(scope, 'settings'));
    }
  }, [isDisabled, router, scope]);

  const refetchAll = async () => {
    await Promise.all([
      permission.refetch(),
      config.refetch(),
      repositories.refetch(),
      capability.refetch(),
    ]);
  };

  if (isLoading) {
    return <ScopeEntrySkeleton />;
  }

  if (isError) {
    return (
      <PlatformErrorScreen
        title="Security Agent"
        errorTitle="Could not load Security Agent"
        onRetry={() => {
          void permission.refetch();
          void config.refetch();
          void capability.refetch();
        }}
        isRetrying={permission.isFetching || config.isFetching || capability.isFetching}
      />
    );
  }

  // Audit-report access shouldn't depend on the agent being connected or
  // enabled — it's a link to historical reports, not agent-managed UI — so
  // it's offered here in the shared shell, ahead of the setup/disabled
  // gates below, whenever the caller can manage the agent.
  const auditAction = capability.canManage ? <AuditReportButton scope={scope} /> : null;

  if (!hasIntegration) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Security Agent" headerRight={auditAction} />
        <SecurityAgentSetup
          title="Connect GitHub to get started"
          description="Install the Kilo GitHub App to automatically sync Dependabot alerts and manage security findings across your repositories."
          buttonLabel="Install GitHub App"
          url={getGitHubIntegrationUrl(
            WEB_BASE_URL,
            isPersonalSecurityScope(scope) ? undefined : scope
          )}
          onConnected={refetchAll}
        />
      </View>
    );
  }

  if (!hasPermissions) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Security Agent" headerRight={auditAction} />
        <SecurityAgentSetup
          title="Additional permissions required"
          description="Security Agent requires the vulnerability_alerts permission to access Dependabot alerts. Re-authorize the GitHub App to grant this permission."
          buttonLabel="Re-authorize GitHub App"
          url={
            permission.data?.reauthorizeUrl ??
            getGitHubIntegrationUrl(
              WEB_BASE_URL,
              isPersonalSecurityScope(scope) ? undefined : scope
            )
          }
          onConnected={refetchAll}
        />
      </View>
    );
  }

  if (isDisabled) {
    // router.replace to settings fires in the effect above; render nothing
    // while the navigation takes effect.
    return null;
  }

  return <DashboardScreen scope={scope} />;
}
