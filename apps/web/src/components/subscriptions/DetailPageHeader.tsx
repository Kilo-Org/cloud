'use client';

import type { ReactNode } from 'react';
import { BackButton } from '@/components/BackButton';
import { SetPageTitle } from '@/components/SetPageTitle';
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge';

export function DetailPageHeader({
  backHref,
  backLabel,
  title,
  status,
  icon,
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  status: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <SetPageTitle title={title} />
      <BackButton href={backHref}>{backLabel}</BackButton>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <div className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-xl">
              {icon}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col items-start gap-2 md:flex-row md:flex-wrap md:items-center md:gap-3">
            <h1 className="text-2xl font-bold md:text-3xl">{title}</h1>
            <SubscriptionStatusBadge status={status} />
          </div>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
