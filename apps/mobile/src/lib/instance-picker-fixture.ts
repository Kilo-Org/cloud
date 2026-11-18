import { type InstancePickerBridge } from '@/lib/picker-bridge';
import { instancePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

/**
 * Development-only entry for the new-session "Run on" sheet. The sheet reads
 * the form's current target from the bridge the composer writes and fetches
 * the live instance list itself, so a deep link alone renders the expired
 * state; this fixture writes the same bridge and opens the same route, which
 * is the only way a design-gate run can measure the sheet.
 *
 * The `cloud` state opens on the Cloud Agent target, the state the form shows
 * before a computer is picked. The `instance` state opens on a computer the
 * live list does not list; the `name=` and `project=` query name that computer,
 * so a run can point the target at a live row whose connection id rotated,
 * exactly as a host that reconnected leaves it. The fixture never picks a row,
 * so the bridge's `onSelect` has nothing to report.
 */
const FIXTURE_PATH =
  /(?:^|\/)dev\/instance-picker-fixture\/(cloud|instance)\/?(?:\?([^#]*))?(?:#.*)?$/;

export function instancePickerFixtureRoute(path: string): string | null {
  const match = FIXTURE_PATH.exec(path);
  if (!match) {
    return null;
  }
  const query = new URLSearchParams(match[2] ?? '');
  const bridge: InstancePickerBridge = {
    // The sheet fetches the live list itself; the bridge carries the target.
    instances: [],
    currentValue:
      match[1] === 'instance'
        ? {
            connectionId: 'fixture-stale-connection',
            name: query.get('name') ?? 'fixture-host',
            projectName: query.get('project') ?? 'fixture-project',
            kind: 'remote',
            startedAt: null,
            gitBranch: null,
          }
        : null,
    pendingComputer: false,
    onSelect: () => undefined,
  };
  instancePickerSlot.set(UNFENCED_ROUTE_KEY, bridge);
  return '/(app)/agent-chat/instance-picker';
}
