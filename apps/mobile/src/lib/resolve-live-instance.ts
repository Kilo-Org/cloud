import { type InstancePickerInstance } from '@/lib/picker-bridge';

/**
 * Resolve the live instance row for a press-time selection against a freshly
 * refetched instance list.
 *
 * A host reboot reconnects its CLI with the same instance `name` and
 * `projectName` but a new `connectionId`. The selector keeps the old
 * `connectionId`; the refetched list carries the live one. This helper maps
 * the selection onto the live row.
 *
 * The pair is not a unique key: two same-folder clients, or two hosts that
 * advertise the same display name, stay listed side by side
 * (`services/session-ingest/src/dos/UserConnectionDO.ts`), and the picker
 * disambiguates exactly those peers with a connectionId suffix. The row
 * carries no other host-stable identity, so a pair that matches more than one
 * live row resolves to `null` and the caller reports it, instead of binding
 * the selection to whichever peer the list happens to list first.
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

  let sameHost: InstancePickerInstance | null = null;
  for (const instance of instances) {
    if (instance.name === selected.name && instance.projectName === selected.projectName) {
      if (sameHost !== null) {
        // A second live peer shares the pair: the selection names no single host.
        return null;
      }
      sameHost = instance;
    }
  }
  return sameHost;
}
