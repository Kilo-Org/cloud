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
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status: string;
  price: string;
  billingDate: string;
  billingDateLabel?: string;
  paymentMethod: string;
  href: string;
  isTerminal?: boolean;
  warningTone?: 'warning' | 'info';
  statusNote?: string | null;
}) {
  return (
    <Link href={href} className="block">
      <Card
        className={cn(
          'transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
          isTerminal && 'opacity-55',
          warningTone === 'warning' && 'border-amber-500/40 bg-amber-500/5',
          warningTone === 'info' && 'border-blue-500/40 bg-blue-500/5'
        )}
      >
        <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="bg-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
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
              <p className="text-muted-foreground text-sm">{subtitle}</p>
              {statusNote ? (
                <p
                  className={cn(
                    'text-sm font-medium',
                    warningTone === 'warning' ? 'text-amber-300' : 'text-blue-300'
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
          <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0 self-center md:mt-3" />
        </CardContent>
      </Card>
    </Link>
  );
}
