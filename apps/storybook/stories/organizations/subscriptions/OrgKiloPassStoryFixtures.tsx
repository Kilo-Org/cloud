import type { ReactNode } from 'react';
import {
  Activity,
  Bot,
  Building,
  ChartColumnIncreasing,
  Cloud,
  CreditCard,
  Key,
  Layers,
  List,
  Shield,
  Sliders,
  Webhook,
} from 'lucide-react';
import HeaderLogo from '@/components/HeaderLogo';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import { SetPageTitle } from '@/components/SetPageTitle';
import { PageTitleProvider } from '@/contexts/PageTitleContext';
import { AppTopbar } from '@/app/(app)/components/AppTopbar';
import { OrganizationSwitcherView } from '@/app/(app)/components/OrganizationSwitcher';
import SidebarMenuList from '@/app/(app)/components/SidebarMenuList';
import SidebarUserFooter from '@/app/(app)/components/SidebarUserFooter';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
} from '@/components/ui/sidebar';
import type {
  OrgKiloPassAllocation,
  OrgKiloPassTerms,
} from '@/components/subscriptions/OrgKiloPassViews';

export const organizationId = 'org-northstar';
export const organizationName = 'Northstar Labs';

export function storyContext({ seeing, how, next }: { seeing: string; how: string; next: string }) {
  return {
    docs: {
      description: {
        story: `| What you are seeing | How this happened | What happens next |
| --- | --- | --- |
| ${seeing} | ${how} | ${next} |`,
      },
    },
  };
}

export const standardTerms: OrgKiloPassTerms = {
  tier: 'tier_49',
  tierName: 'Pro',
  pricePerPassUsd: 49,
  baseCreditsPerPassUsd: 49,
  bonusCreditsPerPassUsd: 12,
  unlockSpendPerPassUsd: 49,
  bonusMode: 'after_base',
};

export const customTerms: OrgKiloPassTerms = {
  tier: 'tier_199',
  tierName: 'Expert',
  pricePerPassUsd: 165,
  baseCreditsPerPassUsd: 185,
  bonusCreditsPerPassUsd: 55,
  unlockSpendPerPassUsd: 170,
  bonusMode: 'upfront',
  isCustom: true,
};

export const nextAllocations: OrgKiloPassAllocation[] = [
  {
    organizationId,
    organizationName,
    kind: 'parent',
    passCount: 70,
  },
  {
    organizationId: 'org-product',
    organizationName: 'Product & Engineering',
    kind: 'child',
    passCount: 30,
  },
  {
    organizationId: 'org-customer',
    organizationName: 'Customer Operations',
    kind: 'child',
    passCount: 20,
  },
];

export const currentAllocations: OrgKiloPassAllocation[] = [
  {
    organizationId,
    organizationName,
    kind: 'parent',
    passCount: 70,
    baseCreditsUsd: 3430,
    qualifyingSpendUsd: 3430,
    unlockTargetUsd: 3430,
    bonusCreditsUsd: 840,
    bonusState: 'unlocked',
  },
  {
    organizationId: 'org-product',
    organizationName: 'Product & Engineering',
    kind: 'child',
    passCount: 30,
    baseCreditsUsd: 1470,
    qualifyingSpendUsd: 1127,
    unlockTargetUsd: 1470,
    bonusCreditsUsd: 360,
    bonusState: 'locked',
  },
  {
    organizationId: 'org-customer',
    organizationName: 'Customer Operations',
    kind: 'child',
    passCount: 20,
    baseCreditsUsd: 980,
    qualifyingSpendUsd: 412,
    unlockTargetUsd: 980,
    bonusCreditsUsd: 240,
    bonusState: 'locked',
  },
];

export const supplementedAllocations: OrgKiloPassAllocation[] = [
  {
    ...currentAllocations[0],
    passCount: 75,
    supplementCreditsUsd: 122.5,
    unlockTargetUsd: 3552.5,
    qualifyingSpendUsd: 3476,
  },
  currentAllocations[1],
  currentAllocations[2],
];

export const upfrontAllocations: OrgKiloPassAllocation[] = currentAllocations.map(allocation => ({
  ...allocation,
  baseCreditsUsd: allocation.passCount * customTerms.baseCreditsPerPassUsd,
  bonusCreditsUsd: allocation.passCount * customTerms.bonusCreditsPerPassUsd,
  qualifyingSpendUsd: 0,
  unlockTargetUsd: 0,
  bonusState: 'upfront_granted',
}));

export const overallocatedAllocations: OrgKiloPassAllocation[] = [
  {
    organizationId,
    organizationName,
    kind: 'parent',
    passCount: 0,
  },
  {
    organizationId: 'org-product',
    organizationName: 'Product & Engineering',
    kind: 'child',
    passCount: 70,
  },
  {
    organizationId: 'org-customer',
    organizationName: 'Customer Operations',
    kind: 'child',
    passCount: 40,
  },
];

export function updateChildAllocation(
  allocations: OrgKiloPassAllocation[],
  organizationIdToUpdate: string,
  passCount: number
) {
  return allocations.map(allocation =>
    allocation.organizationId === organizationIdToUpdate ? { ...allocation, passCount } : allocation
  );
}

export function StoryPage({ children }: { children: ReactNode }) {
  return <div className="m-auto w-full max-w-[1140px] p-4 sm:p-6">{children}</div>;
}

export function OrganizationAppPreview({
  pageTitle,
  children,
  organizationRole = 'owner',
}: {
  pageTitle: string;
  children: ReactNode;
  organizationRole?: 'owner' | 'billing_manager' | 'member';
}) {
  const dashboardItems = [
    { title: 'Organization', icon: Building, url: `/organizations/${organizationId}` },
    {
      title: 'Usage',
      icon: ChartColumnIncreasing,
      url: `/organizations/${organizationId}/usage-details`,
    },
  ];
  const cloudItems = [
    { title: 'Cloud Agent', icon: Cloud, url: `/organizations/${organizationId}/cloud` },
    { title: 'Sessions', icon: List, url: `/organizations/${organizationId}/cloud/sessions` },
    {
      title: 'Webhooks / Triggers',
      icon: Webhook,
      url: `/organizations/${organizationId}/cloud/triggers`,
    },
    { title: 'Code Reviewer', icon: Bot, url: `/organizations/${organizationId}/code-reviews` },
    {
      title: 'Security Agent',
      icon: Shield,
      url: `/organizations/${organizationId}/security-agent`,
    },
  ];
  const accountItems = [
    ...(organizationRole === 'member'
      ? []
      : [
          {
            title: 'Subscriptions',
            icon: CreditCard,
            url: `/organizations/${organizationId}/subscriptions`,
          },
        ]),
    {
      title: 'Model Access',
      icon: Layers,
      url: `/organizations/${organizationId}/providers-and-models`,
    },
    {
      title: 'Custom Modes',
      icon: Sliders,
      url: `/organizations/${organizationId}/custom-modes`,
    },
    {
      title: 'Audit Logs',
      icon: Activity,
      url: `/organizations/${organizationId}/audit-logs`,
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
  ];
  const allUrls = [...dashboardItems, ...cloudItems, ...accountItems].map(item => item.url);

  return (
    <PageTitleProvider>
      <SidebarProvider defaultOpen className="storybook-org-app-shell">
        <AppShellSkipLink />
        <div className="storybook-org-app-shell-content flex min-h-screen w-full bg-background">
          <Sidebar collapsible="icon">
            <SidebarHeader className="p-4">
              <div className="flex flex-col gap-8">
                <HeaderLogo href={`/organizations/${organizationId}`} />
                <OrganizationSwitcherView
                  organizationId={organizationId}
                  organizations={[{ organizationId, organizationName, role: organizationRole }]}
                  onOrganizationSwitch={() => undefined}
                />
              </div>
            </SidebarHeader>
            <SidebarContent>
              <SidebarMenuList label="Dashboard" items={dashboardItems} allUrls={allUrls} />
              <SidebarMenuList label="Cloud" items={cloudItems} allUrls={allUrls} />
              <SidebarMenuList label="Account" items={accountItems} allUrls={allUrls} />
            </SidebarContent>
            <SidebarUserFooter
              user={{
                google_user_name: 'Jean du Plessis',
                google_user_email: 'jean@northstarlabs.com',
                google_user_image_url: '',
              }}
              isLoading={false}
            />
            <SidebarRail />
          </Sidebar>
          <SidebarInset>
            <SetPageTitle title={pageTitle} />
            <AppTopbar />
            <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 bg-background">
              {children}
            </main>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </PageTitleProvider>
  );
}
