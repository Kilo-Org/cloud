'use client';

import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar';
import { useUser } from '@/hooks/useUser';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useEffect, useMemo, useState } from 'react';
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
  Factory,
  Settings,
  CreditCard,
  MessageSquare,
  MessagesSquare,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import HeaderLogo from '@/components/HeaderLogo';
import OrganizationSwitcher from './OrganizationSwitcher';
import SidebarMenuList from './SidebarMenuList';
import SidebarUserFooter from './SidebarUserFooter';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';
import { isEnabledForUser } from '@/lib/code-indexing/util';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { usePathname } from 'next/navigation';

export default function PersonalAppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { data: user, isLoading } = useUser();
  const kiloClawStatusQuery = useKiloClawStatus();
  const pathname = usePathname();

  // Feature flags
  const isAutoTriageFeatureEnabled = useFeatureFlagEnabled('auto-triage-feature');
  const isGastownEnabled = useFeatureFlagEnabled('gastown-access');
  const isKiloChatEnabled = useFeatureFlagEnabled('kilo-chat-feature');
  const isDevelopment = process.env.NODE_ENV === 'development';

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

  // KiloClaw group
  const kiloClawItems: Array<{
    title: string;
    icon: React.ElementType;
    url: string;
    className?: string;
  }> = [
    {
      title: 'Chat',
      icon: MessageSquare,
      url: '/claw/chat',
    },
    ...(isKiloChatEnabled || isDevelopment
      ? [{ title: 'Kilo Chat', icon: MessagesSquare, url: '/claw/kilo-chat' }]
      : []),
    {
      title: 'Subscription',
      icon: CreditCard,
      url: '/claw/subscription',
    },
    {
      title: 'Settings',
      icon: Settings,
      url: '/claw/settings',
    },
    {
      title: "What's New",
      icon: Sparkles,
      url: '/claw/changelog',
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
    {
      title: 'Sessions',
      icon: List,
      url: '/cloud/sessions',
    },
    {
      title: 'Webhooks / Triggers',
      icon: Webhook,
      url: '/cloud/triggers',
    },
    {
      title: 'Code Reviewer',
      icon: Bot,
      url: '/code-reviews',
    },
    {
      title: 'Security Agent',
      icon: Shield,
      url: '/security-agent',
    },
    {
      title: 'Auto Triage',
      icon: ListChecks,
      url: '/auto-triage',
    },
    ...(isAutoTriageFeatureEnabled || isDevelopment
      ? [{ title: 'Auto Fix', icon: Wrench, url: '/auto-fix' }]
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
    ...(isGastownEnabled || isDevelopment
      ? [
          {
            title: 'Gas Town',
            icon: Factory,
            url: '/gastown',
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
    {
      title: 'Subscriptions',
      icon: CreditCard,
      url: '/subscriptions',
    },
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

  const kiloClawBaseUrl = '/claw';
  const kiloClawInstanceState = kiloClawStatusQuery.isSuccess
    ? kiloClawStatusQuery.data.status === null
      ? 'absent'
      : 'present'
    : 'unknown';
  const hasKiloClawInstance = kiloClawInstanceState === 'present';
  const isKiloClawPath = pathname === kiloClawBaseUrl || pathname.startsWith(kiloClawBaseUrl + '/');
  const [sidebarMenu, setSidebarMenu] = useState<'main' | 'kiloClaw'>(
    isKiloClawPath && hasKiloClawInstance ? 'kiloClaw' : 'main'
  );

  useEffect(() => {
    setSidebarMenu(isKiloClawPath && hasKiloClawInstance ? 'kiloClaw' : 'main');
  }, [hasKiloClawInstance, isKiloClawPath]);

  const kiloClawEntryItems: Array<{
    title: string;
    icon: React.ElementType;
    url?: string;
    onClick?: () => void;
    isActive: boolean;
    suffixIcon?: React.ElementType;
  }> = hasKiloClawInstance
    ? [
        {
          title: 'KiloClaw',
          icon: MessageSquare,
          onClick: () => setSidebarMenu('kiloClaw'),
          isActive: isKiloClawPath,
          suffixIcon: ChevronRight,
        },
      ]
    : [
        {
          title: 'KiloClaw',
          icon: MessageSquare,
          url: kiloClawInstanceState === 'absent' ? `${kiloClawBaseUrl}/new` : kiloClawBaseUrl,
          isActive: isKiloClawPath,
        },
      ];

  const backItems: Array<{
    title: string;
    icon: React.ElementType;
    onClick: () => void;
  }> = [
    {
      title: 'Back',
      icon: ChevronLeft,
      onClick: () => setSidebarMenu('main'),
    },
  ];

  const allUrls = useMemo(
    () =>
      [
        kiloClawBaseUrl,
        ...dashboardItems,
        ...kiloClawItems,
        ...cloudItems,
        ...accountItems,
        ...startItems,
      ].map(i => (typeof i === 'string' ? i : i.url)),
    [kiloClawBaseUrl, dashboardItems, kiloClawItems, cloudItems, accountItems, startItems]
  );

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
        {sidebarMenu === 'kiloClaw' ? (
          <>
            <SidebarMenuList label={null} items={backItems} />
            <SidebarMenuList label="KiloClaw" items={kiloClawItems} allUrls={allUrls} />
          </>
        ) : (
          <>
            <SidebarMenuList label="Dashboard" items={dashboardItems} allUrls={allUrls} />
            <SidebarMenuList label={null} items={kiloClawEntryItems} allUrls={allUrls} />
            {cloudItems.length > 0 && (
              <SidebarMenuList label="Cloud" items={cloudItems} allUrls={allUrls} />
            )}
            <SidebarMenuList label="Account" items={accountItems} allUrls={allUrls} />
            <SidebarMenuList label="Start" items={startItems} allUrls={allUrls} />
          </>
        )}
      </SidebarContent>

      <SidebarUserFooter user={user} isLoading={isLoading} />
    </Sidebar>
  );
}
