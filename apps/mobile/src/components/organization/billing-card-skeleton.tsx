import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';

/**
 * The loading shape of one billing readout, at the number of rows that readout
 * paints once it lands.
 *
 * A billing card that grows when its answer arrives moves every section under
 * it: the auto top-up card paints three rows, so a two-row placeholder pushed
 * the Kilo Pass heading below it 48.4 dp on the held-loading gate run. Each
 * caller therefore states the rows its own answer holds.
 */
export function BillingCardSkeleton({ rows = 2 }: Readonly<{ rows?: number }>) {
  return (
    <RowGroup>
      {Array.from({ length: rows }, (_, index) => (
        <RowSkeleton key={index} />
      ))}
    </RowGroup>
  );
}
