/**
 * Pure decisions for the `app:w4c-org-pair` seed fixture.
 *
 * The fixture used to insert a brand-new organization on every run, so a pair
 * that was seeded twice showed up in the mobile account sheet as two identical
 * rows (the picker renders one row per organization membership). These helpers
 * recognize the fixture's own organizations and pick the one to keep, so a
 * rerun converges on a single organization instead of accumulating duplicates.
 */

/**
 * The name the app shows for this fixture's organization.
 *
 * The mobile account sheet renders an organization's name verbatim, so the
 * name must stay user-facing and never carry a `[seed:...]` developer marker.
 */
export const SEEDED_ORGANIZATION_NAME = 'Acme Corp';

/**
 * Marker this fixture writes into `organizations.settings`. `settings` is a
 * shared JSON blob, so the marker is merged in without dropping other keys.
 */
export const FIXTURE_SETTINGS_KEY = 'w4c_org_pair';
export const FIXTURE_SETTINGS_VALUE = 'true';

/**
 * Name prefix on organizations the fixture created before #6332 renamed new
 * rows to {@link SEEDED_ORGANIZATION_NAME}. Those rows still exist, so they
 * must be recognized as fixture rows (and renamed on reuse).
 */
export const LEGACY_ORGANIZATION_NAME_PREFIX = '[seed:w4c-org-pair] ';

export type FixtureOrganizationIdentity = {
  name: string;
  settings: unknown;
};

export type FixtureOrganizationRow = FixtureOrganizationIdentity & {
  id: string;
  created_at: string;
};

export type FixtureMembershipRow = {
  id: string;
  organization_id: string;
  kilo_user_id: string;
  organizationName: string;
  organizationSettings: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFixtureSettingsMarker(settings: unknown): boolean {
  if (!isRecord(settings)) {
    return false;
  }
  const marker = settings[FIXTURE_SETTINGS_KEY];
  // `->>` compares boolean `true` as the string 'true'; accept both shapes.
  return marker === FIXTURE_SETTINGS_VALUE || marker === true;
}

/**
 * True when the organization was created by this fixture: it carries the
 * settings marker, the legacy `[seed:w4c-org-pair] ` name prefix, or the name
 * the fixture writes since #6332.
 */
export function isFixtureOrganization(row: FixtureOrganizationIdentity): boolean {
  if (row.name === SEEDED_ORGANIZATION_NAME) {
    return true;
  }
  if (row.name.startsWith(LEGACY_ORGANIZATION_NAME_PREFIX)) {
    return true;
  }
  return hasFixtureSettingsMarker(row.settings);
}

/**
 * The oldest fixture organization among `rows` (by `created_at`, then `id`),
 * or `undefined` when there is none.
 */
export function selectSeededOrganization(
  rows: readonly FixtureOrganizationRow[]
): FixtureOrganizationRow | undefined {
  const oldestFirst = rows.filter(isFixtureOrganization).sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return left.created_at < right.created_at ? -1 : 1;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
  return oldestFirst[0];
}

/**
 * Memberships of `userIds` in a fixture organization other than
 * `keepOrganizationId`. A membership of an organization this fixture did not
 * create (different name, no marker) is never returned.
 */
export function membershipsToPrune(
  rows: readonly FixtureMembershipRow[],
  keepOrganizationId: string,
  userIds: readonly string[]
): FixtureMembershipRow[] {
  const wantedUsers = new Set(userIds);
  return rows.filter(
    row =>
      wantedUsers.has(row.kilo_user_id) &&
      row.organization_id !== keepOrganizationId &&
      isFixtureOrganization({ name: row.organizationName, settings: row.organizationSettings })
  );
}

/**
 * JSON payload for the fixture settings marker. The caller merges it into the
 * row's existing `settings` (`settings || payload`) so other keys survive.
 */
export function fixtureSettingsMarkerJson(): string {
  return JSON.stringify({ [FIXTURE_SETTINGS_KEY]: FIXTURE_SETTINGS_VALUE });
}
