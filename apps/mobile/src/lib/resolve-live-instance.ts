import { type InstancePickerInstance } from '@/lib/picker-bridge';

/**
 * Resolve the live instance row for a press-time selection against a freshly
 * refetched instance list.
 *
 * A host reboot reconnects its CLI with the same instance `name` and
 * `projectName` but a new `connectionId`. The selector keeps the old
 * `connectionId`; the refetched list carries the live one. This helper maps
 * the selection onto the live row.
 */
export function resolveLiveInstance(
  selected: InstancePickerInstance,
  instances: InstancePickerInstance[]
): InstancePickerInstance | null {
  const sameConnectionId = instances.find(
    instance => instance.connectionId === selected.connectionId
  );
  if (sameConnectionId) {
    return sameConnectionId;
  }

  const sameHost = instances.find(
    instance => instance.name === selected.name && instance.projectName === selected.projectName
  );
  return sameHost ?? null;
}
