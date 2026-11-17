import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';

/** Content-shaped rows in the same slots as a loaded command row. */
export function SlashCommandsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <RowSkeleton key={index} tile subtitle />
      ))}
    </RowGroup>
  );
}
