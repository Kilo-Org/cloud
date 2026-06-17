'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import {
  AlertTriangle,
  BookOpenText,
  CircleHelp,
  ExternalLink,
  FileClock,
  LayoutDashboard,
  ListChecks,
  RefreshCw,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSecurityAgent } from './SecurityAgentContext';

const SECURITY_AGENT_DOCS_URL = 'https://kilo.ai/docs/deploy-secure/security-reviews';

const SECURITY_AGENT_HELP_CONTENT = {
  dashboard: {
    title: 'Dashboard help',
    description:
      'Review current security posture, SLA pressure, and the Security Finding that needs attention first.',
    sections: [
      {
        title: 'Review current posture',
        items: [
          'Use the repository filter to update every dashboard metric for one repository or all repositories.',
          'With SLA tracking on, review compliance, passed deadlines, upcoming deadlines, and findings without deadlines.',
          'With SLA tracking off, focus on open findings, confirmed exploitability, human review, and incomplete analysis.',
        ],
      },
      {
        title: 'Choose the next action',
        items: [
          'The recommended finding prioritizes overdue work, incomplete analysis, confirmed exploitability, and findings needing review.',
          'Open a dashboard metric or recommendation to view matching findings.',
        ],
      },
    ],
    docsUrl: `${SECURITY_AGENT_DOCS_URL}#use-the-dashboard`,
    docsLabel: 'Read about the dashboard',
    docsDescription: 'Metrics, filters, and prioritization',
  },
  findings: {
    title: 'Findings help',
    description:
      'Filter the vulnerability backlog, review evidence, and take the next safe action.',
    sections: [
      {
        title: 'Focus the backlog',
        items: [
          'Filter by repository, severity, or analysis outcome, then sort by severity or SLA due date.',
          'Each finding shows its analysis outcome, remediation status, and available next action.',
        ],
      },
      {
        title: 'Inspect and act',
        items: [
          'Details shows Dependabot metadata, repository context, status, and timing.',
          'Analysis shows triage and sandbox evidence, progress, reasoning, suggested fixes, and retry actions.',
          'Remediation shows eligibility, attempt history, pull request outcomes, validation evidence, and cancellation state.',
        ],
      },
    ],
    docsUrl: `${SECURITY_AGENT_DOCS_URL}#browse-findings`,
    docsLabel: 'Read about findings',
    docsDescription: 'Filters, analysis, and remediation actions',
  },
  auditReport: {
    title: 'Audit report help',
    description: 'Review Security Finding activity recorded by Kilo for a selected UTC period.',
    sections: [
      {
        title: 'Generate a report',
        items: [
          'Choose a UTC date range of up to 90 inclusive calendar days.',
          'Filter finding groups by severity, recorded state, or repository. Matching groups keep their complete in-period timeline.',
        ],
      },
      {
        title: 'Understand the evidence',
        items: [
          'Reports include recorded imports, status and severity changes, analysis outcomes, dismissals, remediation activity, and deletions.',
          'Reports do not prove complete legacy history, repository scan coverage, or aggregate historical SLA compliance.',
          'If report generation fails, Kilo returns no partial report. Select a shorter period and generate it again.',
        ],
      },
    ],
    docsUrl: `${SECURITY_AGENT_DOCS_URL}#audit-reports`,
    docsLabel: 'Read about audit reports',
    docsDescription: 'Periods, filters, evidence, and access',
  },
  settings: {
    title: 'Settings help',
    description: 'Control repository scope, analysis, automation, notifications, and SLA policy.',
    sections: [
      {
        title: 'General',
        items: [
          'Turn Security Agent on or off, select repositories, choose models, and set analysis mode.',
          'Auto mode runs triage first and starts sandbox analysis only when project-specific evidence is needed.',
        ],
      },
      {
        title: 'Automation',
        items: [
          'Configure Auto Analysis, Auto Remediation, and Auto Dismiss thresholds and include-existing behavior.',
          'Auto Remediation is off by default and only starts work for eligible findings that pass safety checks.',
        ],
      },
      {
        title: 'Notifications and SLA',
        items: [
          'New-finding Notifications email eligible recipients when Kilo first inserts a finding. Historical insertions are not replayed.',
          'SLA settings control severity deadlines, warning lead time, SLA Warning Notifications, and SLA Breach Notifications.',
          'Organization emails go only to current organization owners.',
        ],
      },
    ],
    docsUrl: `${SECURITY_AGENT_DOCS_URL}#configure-security-agent`,
    docsLabel: 'Read about settings',
    docsDescription: 'General, automation, notifications, and SLA',
  },
  overview: {
    title: 'Security Agent help',
    description:
      'Learn how Security Agent syncs Security Findings, analyzes risk, and guides remediation.',
    sections: [
      {
        title: 'How Security Agent works',
        items: [
          'Sync imports Dependabot alerts from repositories in scope as Security Findings.',
          'Triage and sandbox analysis determine project-specific risk and recommend the next action.',
          'Remediation can ask Cloud Agent to prepare a fix and open a pull request for an eligible finding.',
        ],
      },
    ],
    docsUrl: `${SECURITY_AGENT_DOCS_URL}#how-security-agent-works`,
    docsLabel: 'View Security Agent documentation',
    docsDescription: 'Setup, analysis, remediation, and settings',
  },
} satisfies Record<
  string,
  {
    title: string;
    description: string;
    sections: { title: string; items: string[] }[];
    docsUrl: string;
    docsLabel: string;
    docsDescription: string;
  }
>;

export function getSecurityAgentHelpContent(pathname: string, basePath: string) {
  const relativePath = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : null;

  if (relativePath === '' || relativePath === '/') return SECURITY_AGENT_HELP_CONTENT.dashboard;
  if (relativePath === '/findings' || relativePath?.startsWith('/findings/')) {
    return SECURITY_AGENT_HELP_CONTENT.findings;
  }
  if (relativePath === '/audit-report' || relativePath?.startsWith('/audit-report/')) {
    return SECURITY_AGENT_HELP_CONTENT.auditReport;
  }
  if (relativePath === '/config' || relativePath?.startsWith('/config/')) {
    return SECURITY_AGENT_HELP_CONTENT.settings;
  }
  return SECURITY_AGENT_HELP_CONTENT.overview;
}

type SecurityAgentLayoutProps = {
  children: React.ReactNode;
};

type SecurityAgentNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

export function getSecurityAgentNavItems({
  basePath,
  showSetupOnly,
  isEnabled,
}: {
  basePath: string;
  showSetupOnly: boolean;
  isEnabled: boolean | undefined;
}): SecurityAgentNavItem[] {
  const auditReport = {
    label: 'Audit report',
    href: `${basePath}/audit-report`,
    icon: FileClock,
  } satisfies SecurityAgentNavItem;
  const settings = {
    label: 'Settings',
    href: `${basePath}/config`,
    icon: Settings2,
  } satisfies SecurityAgentNavItem;

  if (showSetupOnly) return [auditReport, settings];

  return [
    { label: 'Dashboard', href: basePath, icon: LayoutDashboard },
    ...(isEnabled ? [{ label: 'Findings', href: `${basePath}/findings`, icon: ListChecks }] : []),
    auditReport,
    settings,
  ];
}

type SecurityAgentHelpProps = {
  pathname: string;
  basePath: string;
  initiallyOpen?: boolean;
};

export function SecurityAgentHelp({
  pathname,
  basePath,
  initiallyOpen = false,
}: SecurityAgentHelpProps) {
  const content = getSecurityAgentHelpContent(pathname, basePath);

  return (
    <Sheet defaultOpen={initiallyOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="min-h-control-touch self-center px-3 sm:h-control-default sm:min-h-0"
        >
          <CircleHelp aria-hidden="true" />
          Help
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
        <SheetHeader className="border-border border-b p-6 pr-12">
          <SheetTitle className="type-heading">{content.title}</SheetTitle>
          <SheetDescription className="type-body">{content.description}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          {content.sections.map(section => (
            <section key={section.title} className="space-y-2">
              <h3 className="type-body font-medium">{section.title}</h3>
              <ul className="text-muted-foreground type-body list-disc space-y-2 pl-5">
                {section.items.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
          <section>
            <div className="text-muted-foreground type-eyebrow">Resources</div>
            <a
              href={content.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${content.docsLabel} (opens in a new tab)`}
              className="border-border bg-input-background focus-visible:ring-ring hover:bg-surface-hover mt-3 flex min-h-control-touch items-center gap-3 rounded-md border px-3 py-3 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <BookOpenText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="type-body block font-medium">{content.docsLabel}</span>
                <span className="text-muted-foreground type-label block">
                  {content.docsDescription}
                </span>
              </span>
              <ExternalLink className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </a>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SecurityAgentLayout({ children }: SecurityAgentLayoutProps) {
  const pathname = usePathname();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const {
    organizationId,
    isOrg,
    hasIntegration,
    hasPermission,
    isLoadingPermission,
    isLoadingConfig,
    isEnabled,
    hasConfig,
    reauthorizeUrl,
  } = useSecurityAgent();

  const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';
  const showSetupOnly =
    (!isLoadingPermission && !hasIntegration) || (!isLoadingConfig && !hasConfig);

  const navItems = getSecurityAgentNavItems({ basePath, showSetupOnly, isEnabled });

  // Refresh installation mutation (only used in layout for permission alert)
  const { mutate: refreshMutate, isPending: isRefreshing } = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('Permissions refreshed', {
          description: 'GitHub App permissions have been updated from GitHub.',
        });
        const input = organizationId ? { organizationId } : undefined;
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getInstallation.queryKey(input),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.githubApps.listIntegrations.queryKey(input),
        });
        if (isOrg && organizationId) {
          const ownerInput = { organizationId };
          void queryClient.invalidateQueries({
            queryKey: trpc.organizations.securityAgent.getPermissionStatus.queryKey(ownerInput),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.organizations.securityAgent.getRepositories.queryKey(ownerInput),
          });
        } else {
          void queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getPermissionStatus.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getRepositories.queryKey(),
          });
        }
      },
      onError: (error: { message: string }) => {
        toast.error('Failed to refresh permissions', { description: error.message });
      },
    })
  );

  const handleRefreshPermissions = () => {
    if (isOrg && organizationId) {
      refreshMutate({ organizationId });
    } else {
      refreshMutate(undefined);
    }
  };

  const showPermissionRequired = hasIntegration && !hasPermission && !isLoadingPermission;

  function isActive(href: string) {
    if (href === basePath) {
      return pathname === basePath;
    }
    return pathname.startsWith(href);
  }

  return (
    <div className="flex min-h-full flex-col">
      <HideAppTopbar />
      <header className="border-border bg-surface-raised border-b">
        <div className="flex min-w-0">
          <div className="flex w-14 shrink-0 items-start justify-center pt-4 sm:w-16 sm:pt-5">
            <SidebarTrigger
              aria-label="Toggle sidebar"
              className="size-control-touch sm:size-control-default"
            />
          </div>

          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-4 pr-4 sm:gap-x-6 sm:py-5 sm:pr-6 lg:pr-10">
            <h1 id="security-agent-title" className="type-title self-center font-bold text-balance">
              Security Agent
            </h1>
            <div className="col-start-2 row-start-1 self-center sm:row-span-2">
              <SecurityAgentHelp pathname={pathname} basePath={basePath} />
            </div>
            <p className="text-muted-foreground type-body col-span-2 col-start-1 row-start-2 text-pretty sm:col-span-1 md:whitespace-nowrap">
              Monitor and manage Security Findings synced from Dependabot across your repositories.
            </p>
          </div>
        </div>
      </header>

      <nav className="border-border bg-surface-background border-b" aria-label="Security Agent">
        <div className="m-auto flex w-full max-w-[1140px] gap-1 overflow-x-auto px-4 md:px-6">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
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
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="m-auto flex w-full max-w-[1140px] flex-1 flex-col gap-6 p-4 md:p-6">
        {showPermissionRequired && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden="true" />
            <AlertTitle>Additional permissions required</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                Security Agent requires the <code>vulnerability_alerts</code> permission to access
                Dependabot alerts. Re-authorize GitHub App to grant this permission.
              </p>
              <div className="flex flex-wrap gap-3">
                {reauthorizeUrl && (
                  <Button
                    asChild
                    className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90"
                  >
                    <a href={reauthorizeUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-4" aria-hidden="true" />
                      Re-authorize GitHub App
                    </a>
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleRefreshPermissions}
                  disabled={isRefreshing}
                  className="border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <RefreshCw
                    className={`size-4 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    aria-hidden="true"
                  />
                  {isRefreshing ? 'Refreshing...' : 'Refresh permissions'}
                </Button>
              </div>
              <p className="text-sm opacity-80">
                Already approved permissions in GitHub? Refresh permissions to update Security
                Agent.
              </p>
            </AlertDescription>
          </Alert>
        )}

        {children}
      </div>
    </div>
  );
}
