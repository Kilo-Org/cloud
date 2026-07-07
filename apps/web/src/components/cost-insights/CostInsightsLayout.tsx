'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, LayoutDashboard, MessageCircle, Settings2 } from 'lucide-react';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from './feature-visibility';

type CostInsightsLayoutProps = {
  basePath: string;
  children: React.ReactNode;
};

const navItems = [
  { label: 'Overview', path: '', icon: LayoutDashboard },
  ...(COST_INSIGHTS_ASK_KILO_UI_ENABLED
    ? [{ label: 'Ask Kilo', path: '/ask-kilo', icon: MessageCircle }]
    : []),
  { label: 'Activity', path: '/activity', icon: Activity },
  { label: 'Alert settings', path: '/config', icon: Settings2 },
];

export function CostInsightsLayout({ basePath, children }: CostInsightsLayoutProps) {
  const pathname = usePathname();

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
          <div className="min-w-0 flex-1 py-4 pr-4 sm:py-5 sm:pr-6 lg:pr-10">
            <h1 className="type-title font-bold text-balance">Cost Insights</h1>
            <p className="text-muted-foreground type-body mt-2 text-pretty">
              See what drives Credit spend and get notified when spending changes.
            </p>
          </div>
        </div>
      </header>

      <nav className="border-border bg-surface-background border-b" aria-label="Cost Insights">
        <div className="m-auto flex w-full max-w-[1140px] gap-1 overflow-x-auto px-4 md:px-6">
          {navItems.map(item => {
            const href = `${basePath}${item.path}`;
            const active = item.path === '' ? pathname === basePath : pathname.startsWith(href);
            const Icon = item.icon;

            return (
              <Link
                key={href}
                href={href}
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
        {children}
      </div>
    </div>
  );
}
