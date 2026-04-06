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
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  status: string;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <SetPageTitle title={title} />
      <BackButton href={backHref}>{backLabel}</BackButton>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold md:text-3xl">{title}</h1>
          <SubscriptionStatusBadge status={status} />
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
