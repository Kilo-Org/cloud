import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ElementType, ReactNode } from 'react';
import {
  Bot,
  BookOpen,
  Building2,
  Cable,
  ChartColumnIncreasing,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Coins,
  CreditCard,
  Database,
  Download,
  Factory,
  Gift,
  Key,
  List,
  ListChecks,
  MessageSquare,
  Plus,
  Receipt,
  Rocket,
  Settings,
  Shield,
  Sparkles,
  User,
  UserCog,
  Webhook,
  Wrench,
} from 'lucide-react';
import HeaderLogo from '@/components/HeaderLogo';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { OrganizationSwitcherView } from '@/app/(app)/components/OrganizationSwitcher';
import SidebarMenuList from '@/app/(app)/components/SidebarMenuList';
import SidebarUserFooter from '@/app/(app)/components/SidebarUserFooter';

const meta: Meta = {
  title: 'Components/Layout/Sidebar',
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/cloud/sessions',
        query: {},
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

type SidebarStoryItem = {
  title: string;
  icon: ElementType;
  url?: string;
  onClick?: () => void;
  isActive?: boolean;
  suffixIcon?: ElementType;
  subtitle?: string;
  badge?: string;
  className?: string;
};

const mockUser = {
  google_user_name: 'Jean du Plessis',
  google_user_email: 'jean@kilo.ai',
  google_user_image_url: '',
};

const mockOrganizations = [
  {
    organizationId: 'org-kilo',
    organizationName: 'Kilo Code',
    role: 'owner',
  },
  {
    organizationId: 'org-design',
    organizationName: 'Design Systems',
    role: 'member',
  },
];

const dashboardItems: SidebarStoryItem[] = [
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
    icon: ChartColumnIncreasing,
    url: '/usage',
  },
];

const kiloClawItems: SidebarStoryItem[] = [
  {
    title: 'Chat',
    icon: MessageSquare,
    url: '/claw/chat',
  },
  {
    title: 'Subscription',
    icon: CreditCard,
    url: '/claw/subscription',
  },
  {
    title: 'Agents',
    icon: Bot,
    url: '/claw/agents',
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
  {
    title: 'Refer & Earn',
    subtitle: 'Get 1 Month Free',
    badge: 'NEW',
    icon: Gift,
    url: '/claw/refer',
  },
];

const cloudItems: SidebarStoryItem[] = [
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
  {
    title: 'Auto Fix',
    icon: Wrench,
    url: '/auto-fix',
  },
  {
    title: 'Deploy',
    icon: Rocket,
    url: '/deploy',
  },
  {
    title: 'Gas Town',
    icon: Factory,
    url: '/gastown',
  },
  {
    title: 'Managed Indexing',
    icon: Database,
    url: '/code-indexing',
  },
  {
    title: 'MCP Gateway',
    icon: Cable,
    url: '/cloud/mcp-gateway',
  },
];

const accountItems: SidebarStoryItem[] = [
  {
    title: 'Subscriptions',
    icon: CreditCard,
    url: '/subscriptions',
  },
  {
    title: 'Integrations',
    icon: Cable,
    url: '/integrations',
  },
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

const startItems: SidebarStoryItem[] = [
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

const kiloClawEntryItems: SidebarStoryItem[] = [
  {
    title: 'KiloClaw',
    icon: MessageSquare,
    onClick: () => undefined,
    isActive: false,
    suffixIcon: ChevronRight,
  },
];

const backItems: SidebarStoryItem[] = [
  {
    title: 'Back',
    icon: ChevronLeft,
    onClick: () => undefined,
  },
];

const allUrls = [
  '/claw',
  ...dashboardItems,
  ...kiloClawItems,
  ...cloudItems,
  ...accountItems,
  ...startItems,
].flatMap(item => (typeof item === 'string' ? [item] : item.url ? [item.url] : []));

function StoryOrganizationSwitcher() {
  return (
    <OrganizationSwitcherView
      organizations={mockOrganizations}
      onOrganizationSwitch={() => undefined}
    />
  );
}

function StoryTopbar({ title }: { title: string }) {
  return (
    <header className="bg-background sticky top-0 z-10 flex h-14 shrink-0 items-center border-b border-border">
      <div className="flex aspect-square h-14 items-center justify-center">
        <SidebarTrigger className="-ml-1" />
      </div>
      <div className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3">
        <span className="text-foreground block truncate text-sm font-medium">{title}</span>
      </div>
    </header>
  );
}

function StoryInset({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SidebarInset>
      <StoryTopbar title={title} />
      <main id="main-content" tabIndex={-1} className="bg-background w-full flex-1">
        {children}
      </main>
    </SidebarInset>
  );
}

function AppSidebarShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <AppShellSkipLink />
      <div className="flex min-h-screen w-full">
        {children}
        <StoryInset title="Sessions">
          <div className="p-6">
            <div className="max-w-2xl rounded-xl border border-border bg-card p-6">
              <h2 className="type-heading">App shell preview</h2>
              <p className="type-body text-muted-foreground mt-2">
                Layout mirrors the current app sidebar structure: production logo, workspace
                switcher, grouped app navigation, app topbar, and user footer.
              </p>
            </div>
          </div>
        </StoryInset>
      </div>
    </SidebarProvider>
  );
}

function PersonalSidebar({ menu }: { menu: 'main' | 'kiloClaw' }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-3">
            <HeaderLogo href="/profile" />
          </div>
          <StoryOrganizationSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {menu === 'kiloClaw' ? (
          <>
            <SidebarMenuList label={null} items={backItems} />
            <SidebarMenuList label="KiloClaw" items={kiloClawItems} allUrls={allUrls} />
          </>
        ) : (
          <>
            <SidebarMenuList label="Dashboard" items={dashboardItems} allUrls={allUrls} />
            <SidebarMenuList label={null} items={kiloClawEntryItems} allUrls={allUrls} />
            <SidebarMenuList label="Cloud" items={cloudItems} allUrls={allUrls} />
            <SidebarMenuList label="Account" items={accountItems} allUrls={allUrls} />
            <SidebarMenuList label="Start" items={startItems} allUrls={allUrls} />
          </>
        )}
      </SidebarContent>

      <SidebarUserFooter user={mockUser} isLoading={false} />
      <SidebarRail />
    </Sidebar>
  );
}

export const Expanded: Story = {
  render: () => (
    <AppSidebarShell>
      <PersonalSidebar menu="main" />
    </AppSidebarShell>
  ),
};

export const KiloClawMenu: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/claw/chat',
        query: {},
      },
    },
  },
  render: () => (
    <AppSidebarShell>
      <PersonalSidebar menu="kiloClaw" />
    </AppSidebarShell>
  ),
};
