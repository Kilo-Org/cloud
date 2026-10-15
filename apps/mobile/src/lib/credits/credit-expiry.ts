import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { parseTimestamp } from '@/lib/utils';

type CreditBlock = Pick<
  inferRouterOutputs<MobileRouter>['user']['getCreditBlocks']['creditBlocks'][number],
  'balance_mUsd' | 'expiry_date'
>;

export function getNextCreditExpiry(creditBlocks: readonly CreditBlock[]) {
  const dated = creditBlocks.flatMap(block => {
    if (block.expiry_date === null || block.balance_mUsd <= 0) {
      return [];
    }
    const timestamp = parseTimestamp(block.expiry_date).getTime();
    return Number.isFinite(timestamp)
      ? [{ balanceMicrodollars: block.balance_mUsd, expiryDate: block.expiry_date, timestamp }]
      : [];
  });
  const earliest = Math.min(...dated.map(entry => entry.timestamp));
  const first = dated.find(entry => entry.timestamp === earliest);
  if (first === undefined) {
    return undefined;
  }
  let balanceMicrodollars = 0;
  for (const entry of dated) {
    if (entry.timestamp === earliest) {
      balanceMicrodollars += entry.balanceMicrodollars;
    }
  }
  return { ...first, balanceMicrodollars };
}
