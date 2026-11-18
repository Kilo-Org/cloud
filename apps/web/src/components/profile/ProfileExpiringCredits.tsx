'use client';

import { useQuery } from '@tanstack/react-query';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { formatDollars } from '@/lib/utils';
import { Clock, ChevronRight } from 'lucide-react';
import { CardLinkFooter } from '@/components/ui/card.client';
import { useTRPC } from '@/lib/trpc/utils';
import { getExpiringCreditGroups } from '@/lib/getExpiringCreditGroups';

export default function ProfileExpiringCredits() {
  const trpc = useTRPC();
  const { isPending, error, data } = useQuery(trpc.user.getCreditBlocks.queryOptions({}));

  if (isPending || error) {
    return null;
  }

  const expiringCreditGroups = getExpiringCreditGroups(data.creditBlocks);

  if (expiringCreditGroups.length === 0) {
    return null;
  }

  return (
    <CardLinkFooter href="/credits" className="flex items-center gap-2">
      <Clock className="h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        {expiringCreditGroups.map(group => (
          <div key={group.expiry_date}>
            {formatDollars(fromMicrodollars(group.balance_mUsd))} credits expire at{' '}
            {new Date(group.expiry_date).toLocaleString('en-US', {
              timeZone: 'UTC',
              timeZoneName: 'short',
            })}
          </div>
        ))}
      </div>
      <span className="ml-auto">
        <ChevronRight />
      </span>
    </CardLinkFooter>
  );
}
