'use client';

import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  FileClock,
  LayoutDashboard,
  ListChecks,
  PanelLeft,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { SecurityAgentHelp } from '@/components/security-agent/SecurityAgentLayout';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SECURITY_AGENT_BASE_PATH = '/security-agent';
type SecurityAgentStoryPage = 'dashboard' | 'findings' | 'auditReport' | 'settings';

const navigationItems: {
  id: SecurityAgentStoryPage;
  label: string;
  href: string;
  icon: LucideIcon;
}[] = [
  { id: 'dashboard', label: 'Dashboard', href: SECURITY_AGENT_BASE_PATH, icon: LayoutDashboard },
  {
    id: 'findings',
    label: 'Findings',
    href: `${SECURITY_AGENT_BASE_PATH}/findings`,
    icon: ListChecks,
  },
  {
    id: 'auditReport',
    label: 'Audit report',
    href: `${SECURITY_AGENT_BASE_PATH}/audit-report`,
    icon: FileClock,
  },
  {
    id: 'settings',
    label: 'Settings',
    href: `${SECURITY_AGENT_BASE_PATH}/config`,
    icon: Settings2,
  },
];

type SecurityAgentPageHeaderProps = {
  helpInitiallyOpen?: boolean;
  page?: SecurityAgentStoryPage;
};

function getStoryPathname(page: SecurityAgentStoryPage) {
  return navigationItems.find(item => item.id === page)?.href ?? SECURITY_AGENT_BASE_PATH;
}

function SecurityAgentPageHeader({
  helpInitiallyOpen = false,
  page = 'dashboard',
}: SecurityAgentPageHeaderProps) {
  return (
    <header className="border-border bg-surface-raised border-b">
      <div className="flex min-w-0">
        <div className="flex w-14 shrink-0 items-start justify-center pt-4 sm:w-16 sm:pt-5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle sidebar"
            className="size-control-touch sm:size-control-default"
          >
            <PanelLeft aria-hidden="true" />
          </Button>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-4 pr-4 sm:gap-x-6 sm:py-5 sm:pr-6 lg:pr-10">
          <h1 id="security-agent-title" className="type-title self-center font-bold text-balance">
            Security Agent
          </h1>
          <div className="col-start-2 row-start-1 self-center sm:row-span-2">
            <SecurityAgentHelp
              pathname={getStoryPathname(page)}
              basePath={SECURITY_AGENT_BASE_PATH}
              initiallyOpen={helpInitiallyOpen}
            />
          </div>
          <p className="text-muted-foreground type-body col-span-2 col-start-1 row-start-2 text-pretty sm:col-span-1 md:whitespace-nowrap">
            Monitor and manage Security Findings synced from Dependabot across your repositories.
          </p>
        </div>
      </div>
    </header>
  );
}

function SecurityAgentNavigation({ page }: { page: SecurityAgentStoryPage }) {
  return (
    <nav className="border-border bg-surface-background border-b" aria-label="Security Agent">
      <div className="m-auto flex w-full max-w-[1140px] gap-1 overflow-x-auto px-4 md:px-6">
        {navigationItems.map(item => {
          const Icon = item.icon;
          const active = item.id === page;
          return (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring flex min-h-control-touch shrink-0 items-center gap-2 rounded-t-md border-b-2 px-4 type-body font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
                active
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent hover:border-border'
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {item.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function PageHeaderStory({
  helpInitiallyOpen = false,
  page = 'dashboard',
}: SecurityAgentPageHeaderProps) {
  return (
    <div className="bg-surface-background text-foreground min-h-screen">
      <SecurityAgentPageHeader helpInitiallyOpen={helpInitiallyOpen} page={page} />
      <SecurityAgentNavigation page={page} />
    </div>
  );
}

const meta = {
  title: 'Security Agent/Page Header',
  component: PageHeaderStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Responsive Security Agent page header with page-specific help for Dashboard, Findings, Audit report, and Settings.',
      },
    },
  },
  tags: ['!autodocs'],
} satisfies Meta<typeof PageHeaderStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    helpInitiallyOpen: false,
    page: 'dashboard',
  },
};

export const DashboardHelpOpen: Story = {
  name: 'Dashboard help open',
  args: {
    helpInitiallyOpen: true,
    page: 'dashboard',
  },
};

export const FindingsHelpOpen: Story = {
  name: 'Findings help open',
  args: {
    helpInitiallyOpen: true,
    page: 'findings',
  },
};

export const AuditReportHelpOpen: Story = {
  name: 'Audit report help open',
  args: {
    helpInitiallyOpen: true,
    page: 'auditReport',
  },
};

export const SettingsHelpOpen: Story = {
  name: 'Settings help open',
  args: {
    helpInitiallyOpen: true,
    page: 'settings',
  },
};
