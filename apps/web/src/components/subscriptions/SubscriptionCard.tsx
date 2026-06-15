import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge';
import { cn } from '@/lib/utils';

export function SubscriptionCard({
  icon,
  title,
  subtitle,
  status,
  price,
  billingDate,
  billingDateLabel = 'Renews at',
  paymentMethod,
  href,
  isTerminal = false,
  warningTone,
  statusNote,
  action,
  actionPlacement = 'footer',
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: string;
  status: string;
  price: string;
  billingDate: string;
  billingDateLabel?: string;
  paymentMethod: string;
  href: string;
  isTerminal?: boolean;
  warningTone?: 'warning' | 'info';
  statusNote?: string | null;
  action?: ReactNode;
  actionPlacement?: 'footer' | 'top-right';
}) {
  const hasTopRightAction = action && actionPlacement === 'top-right';

  return (
    <Card
      className={cn(
        'relative transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
        isTerminal && 'opacity-55',
        warningTone === 'warning' && 'border-amber-500/40 bg-amber-500/5',
        warningTone === 'info' && 'border-border bg-muted/40'
      )}
    >
      <Link
        href={href}
        className="block focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <CardContent
          className={cn(
            'flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between',
            hasTopRightAction && 'md:relative md:pr-72'
          )}
        >
          <div className="flex min-w-0 gap-3">
            <div className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-xl">
              {icon}
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate font-semibold">{title}</h3>
                <SubscriptionStatusBadge
                  status={status}
                  variant={isTerminal ? 'muted' : 'default'}
                />
              </div>
              {subtitle ? <p className="text-muted-foreground text-sm">{subtitle}</p> : null}
              {statusNote ? (
                <p
                  className={cn(
                    'text-sm font-medium',
                    warningTone === 'warning' ? 'text-amber-300' : 'text-muted-foreground'
                  )}
                >
                  {statusNote}
                </p>
              ) : null}
              <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div>
                  <span className="text-foreground font-medium">Price:</span> {price}
                </div>
                <div>
                  <span className="text-foreground font-medium">{billingDateLabel}:</span>{' '}
                  {billingDate}
                </div>
                <div>
                  <span className="text-foreground font-medium">Payment:</span> {paymentMethod}
                </div>
              </div>
            </div>
          </div>
          <ChevronRight
            className={cn(
              'text-muted-foreground size-5 shrink-0 self-center md:mt-3',
              hasTopRightAction && 'md:absolute md:top-1/2 md:right-5 md:mt-0 md:-translate-y-1/2'
            )}
          />
        </CardContent>
      </Link>
      {hasTopRightAction ? (
        <div className="flex px-5 pb-5 md:absolute md:top-5 md:right-14 md:z-10 md:p-0 [&>button]:w-full sm:[&>button]:w-auto">
          {action}
        </div>
      ) : null}
      {action && actionPlacement === 'footer' ? (
        <div className="flex px-5 pb-5 [&>button]:w-full sm:[&>button]:w-auto">{action}</div>
      ) : null}
    </Card>
  );
}
