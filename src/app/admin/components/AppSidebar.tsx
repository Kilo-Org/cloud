'use client';

import type React from 'react';
import {
  Users,
  DollarSign,
  Building2,
  ShieldAlert,
  Shield,
  Ban,
  Database,
  BarChart,
  Rocket,
  Blocks,
  MessageSquare,
  Sparkles,
  FileSearch,
  GitPullRequest,
  UserX,
  Upload,
  Bell,
} from 'lucide-react';
import { useSession } from 'next-auth/react';
import type { Session } from 'next-auth';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import Link from 'next/link';

type MenuItem = {
  title: (session: Session | null) => string;
  url: string;
  icon: (session: Session | null) => React.ReactElement;
};

type MenuSection = {
  label: string;
  items: MenuItem[];
};

const userManagementItems: MenuItem[] = [
  {
    title: () => 'Users',
    url: '/admin/users',
    icon: () => <Users />,
  },
  {
    title: () => 'Organizations',
    url: '/admin/organizations',
    icon: () => <Building2 />,
  },
  {
    title: () => 'Abuse',
    url: '/admin/abuse',
    icon: () => <ShieldAlert />,
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
];

const financialItems: MenuItem[] = [
  {
    title: () => 'Credit Categories',
    url: '/admin/credit-categories',
    icon: () => <DollarSign />,
  },
  {
    title: () => 'Bulk Credits',
    url: '/admin/bulk-credits',
    icon: () => <Upload />,
  },
  {
    title: () => 'Revenue KPI',
    url: '/admin/revenue',
    icon: () => <DollarSign />,
  },
];

const productEngineeringItems: MenuItem[] = [
  {
    title: () => 'Community PRs',
    url: '/admin/community-prs',
    icon: () => <GitPullRequest />,
  },
  {
    title: () => 'Code Reviewer',
    url: '/admin/code-reviews',
    icon: () => <GitPullRequest />,
  },
  {
    title: () => 'Slack Bot',
    url: '/admin/slack-bot',
    icon: () => <MessageSquare />,
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
    title: () => 'Managed Indexing',
    url: '/admin/code-indexing',
    icon: () => <Database />,
  },
];

const analyticsObservabilityItems: MenuItem[] = [
  {
    title: () => 'Model Stats',
    url: '/admin/model-stats',
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

export function AppSidebar({
  children,
  ...props
}: { children: React.ReactNode } & React.ComponentProps<typeof Sidebar>) {
  const session = useSession();

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/admin" prefetch={false}>
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
                {section.items.map(item => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild>
                      <a href={item.url}>
                        {item.icon(session.data)}
                        <span>{item.title(session.data)}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
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
