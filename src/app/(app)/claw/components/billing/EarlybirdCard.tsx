'use client';

import { Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBillingDate, type ClawBillingStatus } from './billing-types';

type EarlybirdCardProps = {
  earlybird: NonNullable<ClawBillingStatus['earlybird']>;
  onSubscribeClick: () => void;
};

export function EarlybirdCard({ earlybird, onSubscribeClick }: EarlybirdCardProps) {
  const isEndingSoon = earlybird.daysRemaining > 0 && earlybird.daysRemaining <= 30;

  if (isEndingSoon) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🦀</span>
            <span className="text-foreground text-sm font-semibold">KiloClaw Hosting</span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-400">
            <Gift className="h-3 w-3" />
            Early Bird
          </span>
        </div>

        <div className="text-muted-foreground space-y-1 text-sm">
          <div>
            <span>Status:</span> <span className="text-amber-400">Active</span>
          </div>
          <div>
            <span>Access expires:</span>{' '}
            <span className="text-foreground">{formatBillingDate(earlybird.expiresAt)}</span>
          </div>
          <div>
            <span>Days remaining:</span>{' '}
            <span className="text-foreground">{earlybird.daysRemaining}</span>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm text-amber-300">
            Your early bird access is ending soon. Subscribe to a hosting plan to keep your instance
            running after {formatBillingDate(earlybird.expiresAt)}.
          </p>
          <div className="mt-2">
            <Button variant="outline" size="sm" onClick={onSubscribeClick}>
              View Plans
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🦀</span>
          <span className="text-foreground text-sm font-semibold">KiloClaw Hosting</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-400">
          <Gift className="h-3 w-3" />
          Early Bird
        </span>
      </div>

      <div className="text-muted-foreground space-y-1 text-sm">
        <div>
          <span>Status:</span> <span className="text-emerald-400">Active</span>
        </div>
        <div>
          <span>Access expires:</span>{' '}
          <span className="text-foreground">{formatBillingDate(earlybird.expiresAt)}</span>
        </div>
        <div>
          <span>Days remaining:</span>{' '}
          <span className="text-foreground">{earlybird.daysRemaining}</span>
        </div>
      </div>
    </div>
  );
}
