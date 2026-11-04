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
const FIXTURE_PATH = /(?:^|\/)dev\/profile-picker-fixture\/?(?:\?([^#]*))?(?:#.*)?$/;

export function profilePickerFixtureRoute(path: string): string | null {
  const match = FIXTURE_PATH.exec(path);
  if (!match) {
    return null;
  }
  // `?org=` with no value names no organization, so it stays the personal
  // scope; the hook turns any non-undefined id into an organization query.
  const requestedOrganizationId = new URLSearchParams(match[1] ?? '').get('org');
  const organizationId =
    requestedOrganizationId === null || requestedOrganizationId === ''
      ? undefined
      : requestedOrganizationId;
  const bridge: ProfilePickerBridge = {
    organizationId,
    selectedOverrideProfileId: null,
    repoBindingProfileId: null,
    onSelect: () => undefined,
  };
  profilePickerSlot.set(UNFENCED_ROUTE_KEY, bridge);
  return '/(app)/agent-chat/profile-picker';
}
