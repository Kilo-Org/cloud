'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  fromMicrodollars,
} from '@/lib/utils';
import { subDays } from 'date-fns';
import { Clock, ChevronRight } from 'lucide-react';
import { CardLinkFooter } from '@/components/ui/card.client';
import { useTRPC } from '@/lib/trpc/utils';

export default function ProfileExpiringCredits() {
  const trpc = useTRPC();
  const { isPending, error, data } = useQuery(trpc.user.getCreditBlocks.queryOptions({}));

  if (isPending || error) {
    return null;
  }

  const expiringBlocks = data.creditBlocks.filter(block => block.expiry_date !== null);

  if (expiringBlocks.length === 0) {
    return null;
  }

  const expiring_mUsd = expiringBlocks.reduce((sum, block) => sum + block.balance_mUsd, 0);

  const earliestExpiry = expiringBlocks
    .map(block => block.expiry_date)
    .filter((date): date is string => date !== null)
    .sort()[0];

  const dayBeforeExpiry = subDays(new Date(earliestExpiry), 1);
  const dayBeforeExpiryFormatted = formatIsoDateString_UsaDateOnlyFormat(dayBeforeExpiry);

  return (
    <CardLinkFooter href="/credits" className="flex items-center gap-2">
      <Clock className="h-4 w-4 shrink-0" />
      {formatDollars(fromMicrodollars(expiring_mUsd))} bonus credits expire after{' '}
      {dayBeforeExpiryFormatted}
      <span className="ml-auto">
        <ChevronRight />
      </span>
    </CardLinkFooter>
  );
}
