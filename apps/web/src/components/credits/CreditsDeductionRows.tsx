import * as React from 'react';

import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import type { DeductionGroup } from '@/lib/credits/deductionGroups';

function formatSignedAmount(amount_mUsd: number): string {
  const amount = formatMicrodollars(Math.abs(amount_mUsd));
  return amount_mUsd < 0 ? `-${amount}` : `+${amount}`;
}

/**
 * One group per credit event: a purchase or grant as the main row, with the
 * expiry that closed it as the second ledger line of the same group.
 *
 * Each group is its own `<tbody>` so the two rows share one zebra stripe and no
 * divider; the table header lives in the caller.
 */
export function CreditsDeductionRows({ groups }: Readonly<{ groups: DeductionGroup[] }>) {
  return (
    <>
      {groups.map((group, index) => (
        <tbody key={group.key} className={index % 2 === 1 ? 'bg-muted' : undefined}>
          <tr className="border-border border-t">
            <td className="type-body px-4 py-3 whitespace-nowrap tabular-nums sm:px-6">
              {formatIsoDateString_UsaDateOnlyFormat(group.main.date)}
            </td>
            <td className="type-body px-4 py-3 whitespace-normal sm:px-6">
              {group.main.description}
            </td>
            <td className="type-body px-4 py-3 whitespace-nowrap sm:px-6">{group.main.type}</td>
            <td className="type-body px-4 py-3 text-right whitespace-nowrap tabular-nums sm:px-6">
              {formatSignedAmount(group.main.amount_mUsd)}
            </td>
          </tr>
          {group.child && (
            <tr>
              <td className="type-body px-4 py-3 whitespace-nowrap tabular-nums sm:px-6" />
              <td className="type-body px-4 py-3 whitespace-normal sm:px-6">
                <span aria-hidden="true" className="text-muted-foreground mr-1.5">
                  └
                </span>
                {group.child.description}
              </td>
              <td className="type-body px-4 py-3 whitespace-nowrap sm:px-6">{group.child.type}</td>
              <td className="type-body px-4 py-3 text-right whitespace-nowrap tabular-nums sm:px-6">
                {formatSignedAmount(group.child.amount_mUsd)}
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </>
  );
}
