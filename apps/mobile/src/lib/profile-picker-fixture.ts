import { type ProfilePickerBridge } from '@/lib/picker-bridge';
import { profilePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

/**
 * Development-only entry for the new-session profile picker sheet. The sheet
 * reads its current pick and its scope from the bridge the composer writes, so
 * a deep link alone renders the expired state; this fixture writes the same
 * bridge and opens the same route, which is the only way a design-gate run can
 * measure the sheet.
 *
 * The app's development scheme reaches it at the `dev/profile-picker-fixture`
 * path, with no query for the personal scope or an `org` query carrying an
 * organization id for that scope, exactly as the composer would open it. Both
 * open with no override, so the row that clears the override is the checked
 * one. The fixture never presses a row, so the bridge's `onSelect` has nothing
 * to report.
 */
const FIXTURE_PATH = /(?:^|\/)dev\/profile-picker-fixture(?:[?#]|$)/;

export function profilePickerFixtureRoute(path: string): string | null {
  if (!FIXTURE_PATH.test(path)) {
    return null;
  }
  const query = path.split('#')[0]?.split('?')[1] ?? '';
  const organizationId = new URLSearchParams(query).get('org') ?? undefined;
  const bridge: ProfilePickerBridge = {
    organizationId,
    selectedOverrideProfileId: null,
    repoBindingProfileId: null,
    onSelect: () => undefined,
  };
  profilePickerSlot.set(UNFENCED_ROUTE_KEY, bridge);
  return '/(app)/agent-chat/profile-picker';
}
