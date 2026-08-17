import { type ContinuationDestination } from '@/components/agents/continuation-seed';

export type ContinuePickerRow = {
  /**
   * FlatList key. The position, not the destination identity: the picker
   * renders one frozen snapshot that never reorders, appends, or filters, so
   * the index is unique by construction and no server-side id can collide.
   */
  key: string;
  icon: 'cloud' | 'terminal';
  title: string;
  subtitle: string;
  destination: ContinuationDestination;
};

/** Map continuation destinations to the picker's presentational rows. */
export function toContinuePickerRows(
  destinations: readonly ContinuationDestination[]
): ContinuePickerRow[] {
  return destinations.map((destination, index) =>
    destination.kind === 'cloud-agent'
      ? {
          key: `${index}`,
          icon: 'cloud' as const,
          title: 'Cloud Agent',
          subtitle: destination.repo,
          destination,
        }
      : {
          key: `${index}`,
          icon: 'terminal' as const,
          title: destination.instance.name,
          subtitle: destination.instance.projectName,
          destination,
        }
  );
}
