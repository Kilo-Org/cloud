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
  Coins,
  Bell,
} from 'lucide-react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { UserAvatar } from '@/components/UserAvatar';

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
  title: string;
  url: string;
  icon: React.ElementType;
};

type MenuSection = {
  label: string;
  items: MenuItem[];
};

const menuSections: MenuSection[] = [
  {
    label: 'User Management',
    items: [
      { title: 'Users', url: '/admin/users', icon: Users },
      { title: 'Organizations', url: '/admin/organizations', icon: Building2 },
      { title: 'Abuse', url: '/admin/abuse', icon: ShieldAlert },
      { title: 'Bulk Block', url: '/admin/bulk-block', icon: Ban },
      { title: 'Blacklisted Domains', url: '/admin/blacklisted-domains', icon: Shield },
    ],
  },
  {
    label: 'Financial',
    items: [
      { title: 'Credit Categories', url: '/admin/credit-categories', icon: DollarSign },
      { title: 'Bulk Credits', url: '/admin/bulk-credits', icon: Coins },
      { title: 'Revenue KPI', url: '/admin/revenue', icon: DollarSign },
    ],
  },
  {
    label: 'Product & Engineering',
    items: [
      { title: 'Community PRs', url: '/admin/community-prs', icon: GitPullRequest },
      { title: 'Code Reviewer', url: '/admin/code-reviews', icon: GitPullRequest },
      { title: 'Slack Bot', url: '/admin/slack-bot', icon: MessageSquare },
      { title: 'Deployments', url: '/admin/deployments', icon: Rocket },
      { title: 'App Builder', url: '/admin/app-builder', icon: Blocks },
      { title: 'Managed Indexing', url: '/admin/code-indexing', icon: Database },
    ],
  },
  {
    label: 'Analytics & Observability',
    items: [
      { title: 'Model Stats', url: '/admin/model-stats', icon: BarChart },
      { title: 'Session Traces', url: '/admin/session-traces', icon: FileSearch },
      { title: 'Feature Interest', url: '/admin/feature-interest', icon: Sparkles },
      { title: 'Free Model Usage', url: '/admin/free-model-usage', icon: UserX },
      { title: 'Alerting', url: '/admin/alerting', icon: Bell },
    ],
  },
];

export function AppSidebar({
  children,
  ...props
}: { children: React.ReactNode } & React.ComponentProps<typeof Sidebar>) {
  const session = useSession();
  const pathname = usePathname();

  return (
    <Sidebar
      {...props}
      style={
        {
          '--sidebar': 'oklch(0.205 0.015 85)',
          '--sidebar-accent': 'oklch(0.269 0.015 85)',
        } as React.CSSProperties
      }
    >
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    href="/profile"
                    prefetch={false}
                    className={
                      pathname === '/profile'
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : ''
                    }
                  >
                    <UserAvatar
                      image={session.data?.user?.image}
                      name={session.data?.user?.name}
                      size={24}
                      className="mx-[-4px]"
                    />
                    <span>{session.data?.user?.name || 'Profile'}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {menuSections.map(section => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel className="text-muted-foreground font-medium">
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map(item => {
                  const isActive = pathname === item.url || pathname.startsWith(item.url + '/');
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild>
                        <Link
                          href={item.url}
                          prefetch={false}
                          className={
                            isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''
                          }
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
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
