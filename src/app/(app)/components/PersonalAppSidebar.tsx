'use client';

import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar';
import { useUser } from '@/hooks/useUser';
import {
  Code,
  Coins,
  Receipt,
  User,
  UserCog,
  Building2,
  Plus,
  Rocket,
  Cable,
  Cloud,
  Bot,
  Database,
  List,
  Shield,
  ListChecks,
  Download,
  BookOpen,
  Key,
  Wrench,
  Webhook,
} from 'lucide-react';
import HeaderLogo from '@/components/HeaderLogo';
import OrganizationSwitcher from './OrganizationSwitcher';
import SidebarMenuList from './SidebarMenuList';
import SidebarUserFooter from './SidebarUserFooter';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';
import { isEnabledForUser } from '@/lib/code-indexing/util';
import { useFeatureFlagEnabled } from 'posthog-js/react';

export default function PersonalAppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { data: user, isLoading } = useUser();

  // Feature flags
  const isAutoTriageFeatureEnabled = useFeatureFlagEnabled('auto-triage-feature');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isAdmin = user?.is_admin || false;

  // Dashboard group
  const dashboardItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    {
      title: 'Your Profile',
      icon: User,
      url: '/profile',
    },
    {
      title: 'Organizations',
      icon: Building2,
      url: '/organizations',
    },
    {
      title: 'Usage',
      icon: Code,
      url: '/usage',
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
      url: '/app-builder',
    },
    {
      title: 'Cloud Agent',
      icon: Cloud,
      url: '/cloud',
    },
    ...(isAdmin
      ? [
          {
            title: 'Cloud Next',
            icon: Cloud,
            url: '/cloud-next',
          },
        ]
      : []),
    {
      title: 'Sessions',
      icon: List,
      url: '/cloud/sessions',
    },
    {
      title: 'Webhooks',
      icon: Webhook,
      url: '/cloud/webhooks',
    },
    {
      title: 'Code Reviewer',
      icon: Bot,
      url: '/code-reviews',
    },
    ...(isAdmin
      ? [
          {
            title: 'Security Agent',
            icon: Shield,
            url: '/security-agent',
          },
        ]
      : []),
    ...(isAutoTriageFeatureEnabled || isDevelopment
      ? [
          {
            title: 'Auto Triage',
            icon: ListChecks,
            url: '/auto-triage',
          },
          {
            title: 'Auto Fix',
            icon: Wrench,
            url: '/auto-fix',
          },
        ]
      : []),
    ...(ENABLE_DEPLOY_FEATURE
      ? [
          {
            title: 'Deploy',
            icon: Rocket,
            url: '/deploy',
          },
        ]
      : []),
    ...(user && isEnabledForUser(user)
      ? [
          {
            title: 'Managed Indexing',
            icon: Database,
            url: '/code-indexing',
          },
        ]
      : []),
  ];

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
            url: '/integrations',
          },
        ]
      : []),
    {
      title: 'Invoices',
      icon: Receipt,
      url: '/invoices',
    },
    {
      title: 'Credits',
      icon: Coins,
      url: '/credits',
    },
    {
      title: 'Connected Accounts',
      icon: UserCog,
      url: '/connected-accounts',
    },
    {
      title: 'Bring Your Own Key (BYOK)',
      icon: Key,
      url: '/byok',
    },
  ];

  // Start group
  const startItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    {
      title: 'Install',
      icon: Download,
      url: '/install',
    },
    {
      title: 'Learn',
      icon: BookOpen,
      url: '/learn',
    },
  ];

  return (
    <Sidebar {...props}>
      <SidebarHeader className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <HeaderLogo href="/profile" />
          </div>

          {/* Organization Switcher */}
          <OrganizationSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarMenuList label="Dashboard" items={dashboardItems} />
        {cloudItems.length > 0 && <SidebarMenuList label="Cloud" items={cloudItems} />}
        <SidebarMenuList label="Account" items={accountItems} />
        <SidebarMenuList label="Start" items={startItems} />
      </SidebarContent>

      <SidebarUserFooter user={user} isLoading={isLoading} />
    </Sidebar>
  );
}
