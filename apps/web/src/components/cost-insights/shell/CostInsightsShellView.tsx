'use client';

import type { ReactNode } from 'react';
import { DollarSign, Lock, UserRound, UsersRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from '../feature-visibility';
import { StatusBadge } from '../shared/StatusBadge';
import type { CostInsightsAttention, CostInsightsOwner, CostInsightsPage } from '../types';

export function CostInsightsShellView({
  owner,
  activePage,
  attention = 'none',
  unauthorized = false,
  mobilePreview = false,
  basePath = '/cost-insights',
  onPageChange,
  children,
}: {
  owner: CostInsightsOwner;
  activePage: CostInsightsPage;
  attention?: CostInsightsAttention;
  unauthorized?: boolean;
  mobilePreview?: boolean;
  basePath?: string;
  onPageChange?: (page: CostInsightsPage) => void;
  children: ReactNode;
}) {
  const navItems = [
    { page: 'dashboard' as const, label: 'Overview', href: basePath },
    ...(COST_INSIGHTS_ASK_KILO_UI_ENABLED
      ? [{ page: 'ask' as const, label: 'Ask Kilo', href: `${basePath}/ask-kilo` }]
      : []),
    { page: 'events' as const, label: 'Activity', href: `${basePath}/activity` },
    { page: 'config' as const, label: 'Alert settings', href: `${basePath}/config` },
  ];
  const roleLabel =
    owner.authorizedRole === 'billing_manager'
      ? 'Billing manager'
      : owner.authorizedRole === 'owner'
        ? 'Organization owner'
        : owner.authorizedRole === 'admin'
          ? 'Admin view'
          : 'Personal account';

  if (unauthorized) {
    return (
      <main className="bg-background min-h-screen p-4 md:p-6">
        <Alert className="mx-auto max-w-3xl" variant="destructive">
          <Lock className="size-4" aria-hidden="true" />
          <AlertTitle>You do not have access to Cost Insights</AlertTitle>
          <AlertDescription>
            Ask an organization owner or billing manager to review organization spend.
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <div
      className={cn('bg-background min-h-screen text-foreground', mobilePreview && 'max-w-[390px]')}
    >
      <div className="flex min-h-screen">
        <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-64 shrink-0 border-r p-3 md:block">
          <div className="mb-5 px-2">
            <div className="type-body font-semibold">Kilo Cloud</div>
            <div className="type-label text-muted-foreground mt-1 truncate">{owner.name}</div>
          </div>
          <nav aria-label="Usage">
            <div className="type-eyebrow text-muted-foreground px-2 pb-2">Usage</div>
            <a
              href={basePath}
              className="bg-surface-selected text-sidebar-accent-foreground focus-visible:ring-ring flex min-h-control-touch items-center gap-2 rounded-md px-2 type-body font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              <DollarSign className="size-4" aria-hidden="true" />
              <span className="min-w-0 flex-1">Cost Insights</span>
              {attention === 'alert' && <StatusBadge tone="warning">Review</StatusBadge>}
            </a>
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="border-border bg-surface-raised border-b">
            <div className="mx-auto flex max-w-[1140px] flex-col gap-3 p-4 md:p-6">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h1 className="type-title">Cost Insights</h1>
                  <p className="type-body text-muted-foreground mt-1 max-w-2xl">
                    See what is driving Credit spend and get notified when spending changes.
                  </p>
                </div>
                <div className="flex flex-col items-start gap-1 lg:min-w-48 lg:items-end">
                  <span className="type-body font-medium">{owner.name}</span>
                  <span className="type-label text-muted-foreground flex items-center gap-1.5">
                    {owner.type === 'organization' ? (
                      <UsersRound className="size-icon-sm" aria-hidden="true" />
                    ) : (
                      <UserRound className="size-icon-sm" aria-hidden="true" />
                    )}
                    {roleLabel}
                  </span>
                </div>
              </div>
            </div>
          </header>

          <nav className="border-border bg-surface-background border-b" aria-label="Cost Insights">
            <div className="mx-auto flex max-w-[1140px] gap-1 overflow-x-auto px-4 md:px-6">
              {navItems.map(item => {
                const className = cn(
                  'focus-visible:ring-ring flex min-h-control-touch shrink-0 items-center border-b-2 px-3 type-body font-medium focus-visible:ring-2 focus-visible:outline-none',
                  activePage === item.page
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                );
                const content = (
                  <>
                    {item.label}
                    {item.page === 'dashboard' && attention === 'alert' && (
                      <span className="ml-2 flex items-center gap-1.5 type-label text-status-warning">
                        <span
                          className="bg-status-warning-icon size-2 rounded-full"
                          aria-hidden="true"
                        />
                        Review
                      </span>
                    )}
                  </>
                );

                return onPageChange ? (
                  <button
                    key={item.page}
                    type="button"
                    onClick={() => onPageChange(item.page)}
                    aria-current={activePage === item.page ? 'page' : undefined}
                    className={className}
                  >
                    {content}
                  </button>
                ) : (
                  <a
                    key={item.page}
                    href={item.href}
                    aria-current={activePage === item.page ? 'page' : undefined}
                    className={className}
                  >
                    {content}
                  </a>
                );
              })}
            </div>
          </nav>

          <main className="mx-auto flex w-full min-w-0 max-w-[1140px] flex-col gap-6 p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
