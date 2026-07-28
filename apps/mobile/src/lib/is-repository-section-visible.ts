import { type InstancePickerInstance } from '@/lib/picker-bridge';

/**
 * Whether the new-agent screen should render the repository picker section.
 *
 * The repository picker is part of the Cloud-Agent composer. When the user
 * selects a remote `kilo remote` instance (`runOnInstance !== null`), the
 * screen swaps to `RemoteSpawnComposer`, which has no repository picker.
 */
export function isRepositorySectionVisible(runOnInstance: InstancePickerInstance | null): boolean {
  return runOnInstance === null;
}
