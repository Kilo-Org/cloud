import * as React from 'react';

import { TableCell } from '@/components/credits/table-cells';
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
            <TableCell numeric>{formatIsoDateString_UsaDateOnlyFormat(group.main.date)}</TableCell>
            <TableCell wrap>{group.main.description}</TableCell>
            <TableCell>{group.main.type}</TableCell>
            <TableCell numeric align="right">
              {formatSignedAmount(group.main.amount_mUsd)}
            </TableCell>
          </tr>
          {group.child && (
            <tr>
              <TableCell>{''}</TableCell>
              <TableCell wrap>
                <span aria-hidden="true" className="text-muted-foreground mr-1.5">
                  └
                </span>
                {group.child.description}
              </TableCell>
              <TableCell>{group.child.type}</TableCell>
              <TableCell numeric align="right">
                {formatSignedAmount(group.child.amount_mUsd)}
              </TableCell>
            </tr>
          )}
        </tbody>
      ))}
    </>
  );
}
