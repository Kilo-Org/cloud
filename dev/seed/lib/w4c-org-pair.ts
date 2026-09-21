/**
 * Pure decisions for the `app:w4c-org-pair` seed fixture.
 *
 * The fixture used to insert a brand-new organization on every run, so a pair
 * that was seeded twice showed up in the mobile account sheet as two identical
 * rows (the picker renders one row per organization membership). These helpers
 * recognize the fixture's own organizations and pick the one to keep, so a
 * rerun converges on a single organization instead of accumulating duplicates.
 *
 * Recognition is scoped to one owner, never database-wide. Rows the fixture has
 * marked carry the owner email in `settings[FIXTURE_SETTINGS_KEY]`, so only a
 * run that seeds that owner claims them; the legacy `[seed:w4c-org-pair]
 * <owner-email>` name carries it too. Rows created before the fixture marked
 * anything carry no owner, so they are claimed only when the pair is already a
 * member of them — that membership is the fixture's own footprint. An
 * unrelated `Acme Corp` organization the pair is not a member of is never
 * selected, relabeled or pruned.
 */

import { normalizeSeedEmail } from './email';

/**
 * The name the app shows for this fixture's organization.
 *
 * The mobile account sheet renders an organization's name verbatim, so the
 * name must stay user-facing and never carry a `[seed:...]` developer marker.
 */
export const SEEDED_ORGANIZATION_NAME = 'Acme Corp';

/**
 * Marker this fixture writes into `organizations.settings`. The value is the
 * owner's normalized email, which is what names the pair the row belongs to.
 * `settings` is a shared JSON blob, so the marker is merged in without
 * dropping other keys.
 */
export const FIXTURE_SETTINGS_KEY = 'w4c_org_pair';

/**
 * Value the fixture wrote while the marker was a plain flag. A row carrying it
 * names no owner, so it is treated like an unmarked row: claimed only through
 * the pair's membership.
 */
export const FIXTURE_SETTINGS_VALUE = 'true';

/**
 * Name prefix on organizations the fixture created before #6332 renamed new
 * rows to {@link SEEDED_ORGANIZATION_NAME}. The prefix carries the owner email.
 */
export const LEGACY_ORGANIZATION_NAME_PREFIX = '[seed:w4c-org-pair] ';

/** The pair a fixture organization belongs to. */
export type FixturePair = {
  /**
   * Normalized owner email. The legacy name carried exactly this, so it is the
   * identity the fixture's rows have always had.
   */
  ownerEmail: string;
  /** Ids of the organizations the pair is already a member of. */
  organizationIds: ReadonlySet<string>;
};

export type FixtureOrganizationIdentity = {
  id: string;
  name: string;
  settings: unknown;
};

export type FixtureOrganizationRow = FixtureOrganizationIdentity & {
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

/**
 * The owner email the marker names, or `undefined` when the row carries no
 * marker or only the pre-owner {@link FIXTURE_SETTINGS_VALUE} flag.
 */
function markedOwnerEmail(settings: unknown): string | undefined {
  if (!isRecord(settings)) {
    return undefined;
  }
  const marker = settings[FIXTURE_SETTINGS_KEY];
  return typeof marker === 'string' && marker !== FIXTURE_SETTINGS_VALUE ? marker : undefined;
}

/** The owner email a legacy `[seed:w4c-org-pair] ` name carries. */
function legacyOwnerEmail(name: string): string {
  return normalizeSeedEmail(name.slice(LEGACY_ORGANIZATION_NAME_PREFIX.length));
}

/**
 * True when `row` names this owner as the one the fixture created it for: the
 * marker value is the owner email, or the legacy `[seed:w4c-org-pair]
 * <owner-email>` name carries it.
 *
 * A marker naming an owner is authoritative — only a run for that owner may
 * claim the row — so a second pair never inherits the first pair's
 * organization.
 */
function namesPairOwner(row: FixtureOrganizationIdentity, pair: FixturePair): boolean {
  const markedOwner = markedOwnerEmail(row.settings);
  if (markedOwner !== undefined) {
    return normalizeSeedEmail(markedOwner) === pair.ownerEmail;
  }
  if (row.name.startsWith(LEGACY_ORGANIZATION_NAME_PREFIX)) {
    return legacyOwnerEmail(row.name) === pair.ownerEmail;
  }
  return false;
}

/**
 * True when `row` is an organization of `pair`'s fixture run.
 *
 * Besides the rows {@link namesPairOwner} accepts, rows created after #6332
 * and before the fixture marked anything were named {@link
 * SEEDED_ORGANIZATION_NAME} and left no other trace, so they are claimed only
 * when the pair is already a member of them — the fixture's own footprint. A
 * marker that names a different owner belongs to that owner's run, and an
 * unrelated `Acme Corp` the pair does not belong to is not an organization of
 * this pair either.
 */
export function isPairOrganization(row: FixtureOrganizationIdentity, pair: FixturePair): boolean {
  if (namesPairOwner(row, pair)) {
    return true;
  }
  if (markedOwnerEmail(row.settings) !== undefined) {
    return false;
  }
  return row.name === SEEDED_ORGANIZATION_NAME && pair.organizationIds.has(row.id);
}

/**
 * The oldest organization of `pair` among `rows` (by `created_at`, then `id`),
 * or `undefined` when the fixture has none for this pair.
 *
 * Rows the fixture names for this owner win over rows recognized only through
 * the pair's membership, so an older unrelated `Acme Corp` the pair happens to
 * belong to is never preferred over the fixture's own organization.
 */
export function selectSeededOrganization(
  rows: readonly FixtureOrganizationRow[],
  pair: FixturePair
): FixtureOrganizationRow | undefined {
  const owned = rows.filter(row => namesPairOwner(row, pair));
  const candidates = owned.length > 0 ? owned : rows.filter(row => isPairOrganization(row, pair));
  const oldestFirst = candidates.sort((left, right) => {
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
 * Memberships of `userIds` in one of `pair`'s organizations other than
 * `keepOrganizationId`. A membership of an organization this fixture did not
 * create for the pair is never returned.
 */
export function membershipsToPrune(
  rows: readonly FixtureMembershipRow[],
  keepOrganizationId: string,
  userIds: readonly string[],
  pair: FixturePair
): FixtureMembershipRow[] {
  const wantedUsers = new Set(userIds);
  return rows.filter(
    row =>
      wantedUsers.has(row.kilo_user_id) &&
      row.organization_id !== keepOrganizationId &&
      isPairOrganization(
        { id: row.organization_id, name: row.organizationName, settings: row.organizationSettings },
        pair
      )
  );
}

/**
 * JSON payload for the fixture settings marker. The caller merges it into the
 * row's existing `settings` (`settings || payload`) so other keys survive.
 */
export function fixtureSettingsMarkerJson(ownerEmail: string): string {
  return JSON.stringify({ [FIXTURE_SETTINGS_KEY]: normalizeSeedEmail(ownerEmail) });
}
