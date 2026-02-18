'use client';

import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar';
import { useUser } from '@/hooks/useUser';
import {
  Bot,
  Building,
  ChartColumnIncreasing,
  Layers,
  Activity,
  Sliders,
  Sparkles,
  Cable,
  Rocket,
  Database,
  Users,
  CreditCard,
  Cloud,
  Key,
  List,
  Shield,
  Plus,
  ListChecks,
  Wrench,
  Webhook,
} from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import OrganizationSwitcher from './OrganizationSwitcher';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import HeaderLogo from '@/components/HeaderLogo';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import SidebarMenuList from './SidebarMenuList';
import SidebarUserFooter from './SidebarUserFooter';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';
import { useFeatureFlagEnabled } from 'posthog-js/react';

type OrganizationAppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  organizationId: string;
};

export default function OrganizationAppSidebar({
  organizationId,
  ...props
}: OrganizationAppSidebarProps) {
  const { data: user, isLoading } = useUser();
  const pathname = usePathname();
  const { assumedRole, setAssumedRole, setOriginalRole } = useRoleTesting();
  // Fetch full organization data to access settings
  const { data: organizationData } = useOrganizationWithMembers(organizationId);

  // Feature flags
  const isAutoTriageFeatureEnabled = useFeatureFlagEnabled('auto-triage-feature');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isAdmin = user?.is_admin || false;

  // Get current organization role and data
  const currentOrg = organizationData;
  const actualRole =
    currentOrg?.members.find(member => {
      if (member.status !== 'active') return false;
      return member.id === user?.id;
    })?.role || 'member';

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || actualRole;

  // Show welcome if organization was created less than a week ago OR if currently on welcome page
  const showWelcome = useMemo(() => {
    if (pathname.includes('/welcome')) return true;
    // Otherwise, show if organization was created less than a week ago
    if (!currentOrg?.created_at) return false;

    const orgCreationDate = new Date(currentOrg.created_at).getTime();
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

    return orgCreationDate > oneWeekAgo;
  }, [currentOrg?.created_at, pathname]);

  // Update role testing state when organization changes
  useEffect(() => {
    if (actualRole) {
      setOriginalRole(actualRole);
      setAssumedRole(null);
    } else if (user?.is_admin) {
      // Admin user viewing an organization they're not a member of
      // Set a default role for role testing and default to KILO ADMIN
      setOriginalRole('member');
      setAssumedRole('KILO ADMIN');
    } else {
      setOriginalRole(null);
      setAssumedRole(null);
    }
  }, [actualRole, user?.is_admin, setOriginalRole, setAssumedRole]);

  // Dashboard group
  const dashboardItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    ...(showWelcome
      ? [
          {
            title: 'Welcome',
            icon: Sparkles,
            url: `/organizations/${organizationId}/welcome`,
          },
        ]
      : []),
    {
      title: 'Organization',
      icon: Building,
      url: `/organizations/${organizationId}`,
    },
    {
      title: 'Usage',
      icon: ChartColumnIncreasing,
      url: `/organizations/${organizationId}/usage-details`,
    },
  ];

  // Cloud group
  const cloudItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    {
      title: 'App Builder',
      icon: Plus,
      url: `/organizations/${organizationId}/app-builder`,
    },
    {
      title: 'Cloud Agent',
      icon: Cloud,
      url: `/organizations/${organizationId}/cloud`,
    },
    {
      title: 'Sessions',
      icon: List,
      url: `/organizations/${organizationId}/cloud/sessions`,
    },
    {
      title: 'Webhooks',
      icon: Webhook,
      url: `/organizations/${organizationId}/cloud/webhooks`,
    },
    {
      title: 'Code Reviewer',
      icon: Bot,
      url: `/organizations/${organizationId}/code-reviews`,
    },
    ...(isAdmin
      ? [
          {
            title: 'Security Agent',
            icon: Shield,
            url: `/organizations/${organizationId}/security-agent`,
          },
        ]
      : []),
    ...(isAutoTriageFeatureEnabled || isDevelopment
      ? [
          {
            title: 'Auto Triage',
            icon: ListChecks,
            url: `/organizations/${organizationId}/auto-triage`,
          },
          {
            title: 'Auto Fix',
            icon: Wrench,
            url: `/organizations/${organizationId}/auto-fix`,
          },
        ]
      : []),
    ...(ENABLE_DEPLOY_FEATURE
      ? [
          {
            title: 'Deploy',
            icon: Rocket,
            url: `/organizations/${organizationId}/deploy`,
          },
        ]
      : []),
    ...(organizationData?.settings?.code_indexing_enabled
      ? [
          {
            title: 'Managed Indexing',
            icon: Database,
            url: `/organizations/${organizationId}/code-indexing`,
          },
        ]
      : []),
  ];

  const hasOwnerLevelAccess = currentRole === 'owner' || currentRole === 'billing_manager';
  // Account group
  const accountItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    ...(ENABLE_DEPLOY_FEATURE
      ? [
          {
            title: 'Integrations',
            icon: Cable,
            url: `/organizations/${organizationId}/integrations`,
          },
        ]
      : []),
    ...(hasOwnerLevelAccess && currentOrg?.plan === 'enterprise'
      ? [
          {
            title: 'Model Access',
            icon: Layers,
            url: `/organizations/${organizationId}/providers-and-models`,
          },
        ]
      : []),
    {
      title: 'Custom Modes',
      icon: Sliders,
      url: `/organizations/${organizationId}/custom-modes`,
    },
    ...(hasOwnerLevelAccess && currentOrg?.plan === 'enterprise'
      ? [
          {
            title: 'Audit Logs',
            icon: Activity,
            url: `/organizations/${organizationId}/audit-logs`,
          },
        ]
      : []),
    ...(hasOwnerLevelAccess
      ? [
          {
            title: 'Subscription',
            icon: Users,
            url: `/organizations/${organizationId}/subscription`,
          },
          {
            title: 'Invoices',
            icon: CreditCard,
            url: `/organizations/${organizationId}/payment-details`,
          },
          {
            title: 'Bring Your Own Key (BYOK)',
            icon: Key,
            url: `/organizations/${organizationId}/byok`,
          },
        ]
      : []),
  ];

  // Determine if we should show the OrganizationSwitcher
  // Hide it when an admin user is viewing an organization they're not a member of
  const shouldShowOrganizationSwitcher = !user?.is_admin || currentOrg;

  return (
    <Sidebar {...props}>
      <SidebarHeader className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <HeaderLogo href="/profile" />
          </div>

          {/* Organization Switcher */}
          {shouldShowOrganizationSwitcher && (
            <OrganizationSwitcher organizationId={organizationId} />
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarMenuList label="Dashboard" items={dashboardItems} />
        {cloudItems.length > 0 && <SidebarMenuList label="Cloud" items={cloudItems} />}
        {accountItems.length > 0 && <SidebarMenuList label="Account" items={accountItems} />}
      </SidebarContent>

      <SidebarUserFooter user={user} isLoading={isLoading} />
    </Sidebar>
  );
}
