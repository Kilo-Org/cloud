'use client';

import type React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  DollarSign,
  Building2,
  Clock,
  Shield,
  ShieldCheck,
  Ban,
  Database,
  BarChart,
  Rocket,
  Blocks,
  Bot,
  Sparkles,
  MailCheck,
  FileSearch,
  GitPullRequest,
  UserX,
  Upload,
  Bell,
  Network,
  KeyRound,
  Copy,
  Megaphone,
  Coins,
  Scale,
  Route,
} from 'lucide-react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import type { Session } from 'next-auth';
import KiloCrabIcon from '@/components/KiloCrabIcon';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { useAdminPermissions } from '@/app/admin/useAdminPermissions';

type MenuItem = {
  title: (session: Session | null) => string;
  url: string;
  icon: (session: Session | null) => React.ReactElement;
};

type MenuSection = {
  label: string;
  items: MenuItem[];
};

const DISPUTES_SUMMARY_STALE_TIME_MS = 60_000;

const userManagementItems: MenuItem[] = [
  {
    title: () => 'Users',
    url: '/admin/users',
    icon: () => <Users />,
  },
  {
    title: () => 'Admins',
    url: '/admin/admins',
    icon: () => <ShieldCheck />,
  },
  {
    title: () => 'Organizations',
    url: '/admin/organizations',
    icon: () => <Building2 />,
  },
  {
    title: () => 'Trial Organizations',
    url: '/admin/organizations/trials',
    icon: () => <Clock />,
  },
  {
    title: () => 'Bulk Block',
    url: '/admin/bulk-block',
    icon: () => <Ban />,
  },
  {
    title: () => 'Blacklisted Domains',
    url: '/admin/blacklisted-domains',
    icon: () => <Shield />,
  },
  {
    title: () => 'Backfills',
    url: '/admin/backfills',
    icon: () => <KeyRound />,
  },
  {
    title: () => 'Account Deduplication',
    url: '/admin/account-deduplication',
    icon: () => <Copy />,
  },
];

const financialItems: MenuItem[] = [
  {
    title: () => 'Credit Categories',
    url: '/admin/credit-categories',
    icon: () => <DollarSign />,
  },
  {
    title: () => 'Credit Campaigns',
    url: '/admin/credit-campaigns',
    icon: () => <Megaphone />,
  },
  {
    title: () => 'Bulk Credits & Trials',
    url: '/admin/bulk-credits',
    icon: () => <Upload />,
  },
  {
    title: () => 'Kilo Pass Bulk Cancel',
    url: '/admin/kilo-pass/bulk-cancel',
    icon: () => <Coins />,
  },
  {
    title: () => 'Disputes',
    url: '/admin/disputes',
    icon: () => <Scale />,
  },
  {
    title: () => 'Early Fraud Warnings',
    url: '/admin/early-fraud-warnings',
    icon: () => <Shield />,
  },
  {
    title: () => 'Revenue KPI',
    url: '/admin/revenue',
    icon: () => <DollarSign />,
  },
];

const productEngineeringItems: MenuItem[] = [
  {
    title: () => 'KiloClaw',
    url: '/admin/kiloclaw',
    icon: () => <KiloCrabIcon className="size-4" />,
  },
  {
    title: () => 'KiloClaw referrals',
    url: '/admin/kiloclaw-referrals',
    icon: () => <KiloCrabIcon className="size-4" />,
  },
  {
    title: () => 'Community Contributions',
    url: '/admin/community-prs',
    icon: () => <GitPullRequest />,
  },
  {
    title: () => 'Code Reviewer',
    url: '/admin/code-reviews',
    icon: () => <GitPullRequest />,
  },
  {
    title: () => 'Kilo Bot',
    url: '/admin/bots',
    icon: () => <Bot />,
  },
  {
    title: () => 'Deployments',
    url: '/admin/deployments',
    icon: () => <Rocket />,
  },
  {
    title: () => 'App Builder',
    url: '/admin/app-builder',
    icon: () => <Blocks />,
  },
  {
    title: () => 'Email Testing',
    url: '/admin/email-testing',
    icon: () => <MailCheck />,
  },
  {
    title: () => 'Managed Indexing',
    url: '/admin/code-indexing',
    icon: () => <Database />,
  },
  {
    title: () => 'Gas Town',
    url: '/admin/gastown',
    icon: () => <Network />,
  },
  {
    title: () => 'Gateway',
    url: '/admin/gateway',
    icon: () => <Network />,
  },
  {
    title: () => 'Auto Routing',
    url: '/admin/auto-routing',
    icon: () => <Route />,
  },
  {
    title: () => 'Coding plans',
    url: '/admin/coding-plans',
    icon: () => <KeyRound />,
  },
];

const analyticsObservabilityItems: MenuItem[] = [
  {
    title: () => 'Model Stats',
    url: '/admin/model-stats',
    icon: () => <BarChart />,
  },
  {
    title: () => 'Model Benchmarks',
    url: '/admin/model-eval-ingest',
    icon: () => <FileSearch />,
  },
  {
    title: () => 'Cloud Agent health',
    url: '/admin/cloud-agent-next',
    icon: () => <BarChart />,
  },
  {
    title: () => 'Session Traces',
    url: '/admin/session-traces',
    icon: () => <FileSearch />,
  },
  {
    title: () => 'Feature Interest',
    url: '/admin/feature-interest',
    icon: () => <Sparkles />,
  },
  {
    title: () => 'Free Model Usage',
    url: '/admin/free-model-usage',
    icon: () => <UserX />,
  },
  {
    title: () => 'Alerting',
    url: '/admin/alerting',
    icon: () => <Bell />,
  },
];

const menuSections: MenuSection[] = [
  {
    label: 'User Management',
    items: userManagementItems,
  },
  {
    label: 'Financial',
    items: financialItems,
  },
  {
    label: 'Product & Engineering',
    items: productEngineeringItems,
  },
  {
    label: 'Analytics & Observability',
    items: analyticsObservabilityItems,
  },
];

const adminMenuUrls = menuSections.flatMap(section => section.items.map(item => item.url));

function isAdminMenuItemActive(pathname: string, itemUrl: string) {
  const matchesPrefix = pathname === itemUrl || pathname.startsWith(itemUrl + '/');
  if (!matchesPrefix) return false;

  return !adminMenuUrls.some(
    url =>
      url !== itemUrl &&
      url.length > itemUrl.length &&
      (pathname === url || pathname.startsWith(url + '/'))
  );
}

type AppSidebarViewProps = {
  children: React.ReactNode;
  pathname: string;
  session: Session | null;
  pendingDisputesCount?: number;
  canViewSessions?: boolean;
} & React.ComponentProps<typeof Sidebar>;

export function AppSidebarView({
  children,
  pathname,
  session,
  pendingDisputesCount = 0,
  canViewSessions = false,
  ...props
}: AppSidebarViewProps) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild isActive={pathname === '/admin'}>
              <Link
                href="/admin"
                prefetch={false}
                aria-current={pathname === '/admin' ? 'page' : undefined}
              >
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <span className="text-lg font-bold">K</span>
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">Kilo Admin</span>
                  <span className="text-sidebar-foreground/70 text-xs">Dashboard</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {menuSections.map(section => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items
                  .filter(item => item.url !== '/admin/session-traces' || canViewSessions)
                  .map(item => {
                    const isActive = isAdminMenuItemActive(pathname, item.url);

                    return (
                      <SidebarMenuItem key={item.url}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          className={cn(
                            item.url === '/admin/disputes' && pendingDisputesCount > 0 && 'pr-10'
                          )}
                        >
                          <Link
                            href={item.url}
                            prefetch={false}
                            aria-current={isActive ? 'page' : undefined}
                          >
                            {item.icon(session)}
                            <span>{item.title(session)}</span>
                          </Link>
                        </SidebarMenuButton>
                        {item.url === '/admin/disputes' && pendingDisputesCount > 0 ? (
                          <SidebarMenuBadge className="bg-destructive/15 text-destructive ring-1 ring-destructive/30">
                            {pendingDisputesCount}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-4">{children}</SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

export function AppSidebar({
  children,
  ...props
}: { children: React.ReactNode } & React.ComponentProps<typeof Sidebar>) {
  const session = useSession();
  const pathname = usePathname();
  const trpc = useTRPC();
  const { canViewSessions } = useAdminPermissions();
  const disputesSummaryQuery = useQuery({
    ...trpc.admin.disputes.summary.queryOptions(),
    staleTime: DISPUTES_SUMMARY_STALE_TIME_MS,
  });
  const pendingDisputesCount = disputesSummaryQuery.data?.pendingCount ?? 0;

  return (
    <AppSidebarView
      {...props}
      pathname={pathname}
      session={session.data}
      pendingDisputesCount={pendingDisputesCount}
      canViewSessions={canViewSessions}
    >
      {children}
    </AppSidebarView>
  );
}
