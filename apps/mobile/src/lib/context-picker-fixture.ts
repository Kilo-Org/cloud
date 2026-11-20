import { type ContextPickerBridge } from '@/lib/picker-bridge';
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

/**
 * Development-only entry for the account picker sheet
 * (`kiloapp:///dev/context-picker-fixture`).
 *
 * `(app)/context-picker` reads its rows and its check mark from the bridge its
 * opener writes, so a link that names the route alone presents the "Options
 * expired" shell: nothing wrote the rows, and a forced data state wrapped
 * around that link therefore never reaches the sheet. Every other picker has
 * the same shape and the same fixture (`profile-picker-fixture`,
 * `instance-picker-fixture`), writing the bridge and returning the sheet's own
 * route; this one does the same for the account picker.
 *
 * The rows are fixed fixture accounts: the picker's rows are bridge data, not a
 * read, so no forced data state reaches them and the sheet renders the same
 * accounts in every mode. The first row carries the check mark. A pick runs the
 * bridge's `onSelect` exactly as a real one would; this fixture's `onSelect`
 * does nothing, so the sheet can be driven without switching the account.
 */
const FIXTURE_PATH = /(?:^|\/)dev\/context-picker-fixture\/?(?:[?#].*)?$/;

const CONTEXT_PICKER_ROUTE = '/(app)/context-picker';

/** The accounts the fixture lists, in row order. */
const FIXTURE_ACCOUNTS: readonly string[] = ['Fixture Personal', 'Fixture Acme'];

/**
 * The route the sheet presents on, or null for every other link. `undefined` is
 * never returned: the caller treats a string as "open this route" and null as
 * "not mine".
 */
export function contextPickerFixtureRoute(path: string): string | null {
  if (!FIXTURE_PATH.test(path)) {
    return null;
  }
  const bridge: ContextPickerBridge = {
    options: [...FIXTURE_ACCOUNTS],
    currentIndex: 0,
    onSelect: () => undefined,
  };
  contextPickerSlot.set(UNFENCED_ROUTE_KEY, bridge);
  return CONTEXT_PICKER_ROUTE;
}
