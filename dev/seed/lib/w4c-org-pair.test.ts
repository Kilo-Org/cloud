import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectSeededOrganizations,
  SEEDED_ORGANIZATION_NAME,
  type SeededOrganizationRow,
} from '../app/w4c-org-pair';
import {
  FIXTURE_SETTINGS_KEY,
  FIXTURE_SETTINGS_VALUE,
  isPairOrganization,
  LEGACY_ORGANIZATION_NAME_PREFIX,
  membershipsToPrune,
  selectSeededOrganization,
} from './w4c-org-pair';
import type { FixturePair } from './w4c-org-pair';

const CREATED_AT = '2026-03-01T00:00:00.000Z';
const OWNER = 'owner-user-id';
const OTHER_OWNER = 'other-user-id';
const OWNER_EMAIL = 'owner@example.com';
const OTHER_OWNER_EMAIL = 'other-owner@example.com';

function organization(
  id: string,
  name: string,
  created_at: string,
  settings: unknown = {}
): { id: string; name: string; created_at: string; settings: unknown } {
  return { id, name, created_at, settings };
}

function seededOrganization(
  id: string,
  name: string,
  createdByUserId: string | null
): SeededOrganizationRow {
  return { id, name, createdByUserId };
}

function membership(
  id: string,
  organization_id: string,
  kilo_user_id: string,
  organizationName: string,
  organizationSettings: unknown = {}
) {
  return { id, organization_id, kilo_user_id, organizationName, organizationSettings };
}

function pair(ownerEmail = OWNER_EMAIL, organizationIds: string[] = []): FixturePair {
  return { ownerEmail, organizationIds: new Set(organizationIds) };
}

// The mobile account sheet renders an organization's name verbatim, so the
// fixture must never hand it a developer marker such as `[seed:w4c-org-pair]`.
void test('the seeded organization name is user-facing, not a developer marker', () => {
  assert.equal(SEEDED_ORGANIZATION_NAME.trim().length > 0, true);
  assert.equal(SEEDED_ORGANIZATION_NAME.includes('[seed:'), false);
});

// The explorer capture showed the account sheet listing the same organization
// row about thirteen times, one row per seeding round: the reruns accumulated
// instead of replacing the fixture's own organization.
void test('a rerun selects every row the fixture left behind, so none accumulate', () => {
  const accumulated = Array.from({ length: 13 }, (_, index) =>
    seededOrganization(`legacy-${index}`, '[seed:w4c-org-pair] owner@example.com', null)
  );

  const selected = selectSeededOrganizations(accumulated, OWNER);

  assert.equal(selected.length, 13);

  // A rerun deletes what it selected and inserts one organization: the sheet
  // then lists the pair once, whatever earlier rounds left.
  const rerun = [
    ...accumulated.filter(row => !selected.includes(row)),
    seededOrganization('current', SEEDED_ORGANIZATION_NAME, OWNER),
  ];
  assert.deepEqual(selectSeededOrganizations(rerun, OWNER), [
    seededOrganization('current', SEEDED_ORGANIZATION_NAME, OWNER),
  ]);
});

// The current fixture name is user-facing, so it identifies the fixture's own
// rows through the account that created them, and through the rows an earlier
// run left without a creator (the fixture only records one since the reset).
void test('the current name counts for the owner and for a pre-reset row', () => {
  assert.deepEqual(
    selectSeededOrganizations([seededOrganization('mine', SEEDED_ORGANIZATION_NAME, OWNER)], OWNER),
    [seededOrganization('mine', SEEDED_ORGANIZATION_NAME, OWNER)]
  );
  assert.deepEqual(
    selectSeededOrganizations(
      [seededOrganization('pre-reset', SEEDED_ORGANIZATION_NAME, null)],
      OWNER
    ),
    [seededOrganization('pre-reset', SEEDED_ORGANIZATION_NAME, null)]
  );
});

// A name match alone never selects another account's row.
void test("another account's organization of the same name stays", () => {
  assert.deepEqual(
    selectSeededOrganizations(
      [seededOrganization('theirs', SEEDED_ORGANIZATION_NAME, OTHER_OWNER)],
      OWNER
    ),
    []
  );
});

void test('isPairOrganization recognizes the rows this owner created', () => {
  // Rows the fixture marks carry the owner email.
  assert.equal(
    isPairOrganization(
      organization('org-marked', 'Renamed Org', CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: OWNER_EMAIL,
      }),
      pair()
    ),
    true
  );
  // Pre-#6332 rows carry the owner in a `[seed:w4c-org-pair] ` name.
  assert.equal(
    isPairOrganization(
      organization('org-legacy', `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`, CREATED_AT),
      pair()
    ),
    true
  );
  // Rows created after #6332 but before the fixture marked anything are named
  // `Acme Corp` and carry no other trace than the pair's membership.
  assert.equal(
    isPairOrganization(
      organization('org-name', SEEDED_ORGANIZATION_NAME, CREATED_AT),
      pair(OWNER_EMAIL, ['org-name'])
    ),
    true
  );
});

void test('isPairOrganization rejects an organization this pair does not belong to', () => {
  // Finding 1: an organization literally named `Acme Corp` that this fixture
  // never created must not be treated as fixture data.
  assert.equal(
    isPairOrganization(organization('org-unrelated', SEEDED_ORGANIZATION_NAME, CREATED_AT), pair()),
    false
  );
  assert.equal(
    isPairOrganization(
      organization('org-other', 'Unrelated Org', CREATED_AT, { other: 'true' }),
      pair()
    ),
    false
  );
  assert.equal(
    isPairOrganization(organization('org-similar', 'Acme Corp Ltd', CREATED_AT), pair()),
    false
  );
  // A plain `true` flag names no owner; without the pair's membership it is
  // not this pair's row either.
  assert.equal(
    isPairOrganization(
      organization('org-flag', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: FIXTURE_SETTINGS_VALUE,
      }),
      pair()
    ),
    false
  );
});

void test('isPairOrganization never claims another pair\u2019s marked organization', () => {
  // Finding 2: the marker names its owner, so a run for a different owner must
  // not inherit the first owner's organization, not even through a member the
  // two runs share.
  assert.equal(
    isPairOrganization(
      organization('org-other-pair', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: OTHER_OWNER_EMAIL,
      }),
      pair()
    ),
    false
  );
  assert.equal(
    isPairOrganization(
      organization('org-other-marked', 'Renamed Org', CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: OTHER_OWNER_EMAIL,
      }),
      // The shared member belongs to the first owner's organization.
      pair(OWNER_EMAIL, ['org-other-pair', 'org-other-marked'])
    ),
    false
  );
  assert.equal(
    isPairOrganization(
      organization(
        'org-other-legacy',
        `${LEGACY_ORGANIZATION_NAME_PREFIX}${OTHER_OWNER_EMAIL}`,
        CREATED_AT
      ),
      pair()
    ),
    false
  );
});

void test('selectSeededOrganization keeps the oldest of the owner\u2019s duplicates', () => {
  const rows = [
    organization(
      'org-newest',
      `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`,
      '2026-03-03T00:00:00.000Z'
    ),
    organization(
      'org-oldest',
      `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`,
      '2026-03-01T00:00:00.000Z'
    ),
    organization(
      'org-middle',
      `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`,
      '2026-03-02T00:00:00.000Z'
    ),
  ];
  assert.equal(selectSeededOrganization(rows, pair())?.id, 'org-oldest');
});

void test('selectSeededOrganization keeps the oldest row that only the membership identifies', () => {
  const rows = [
    organization('org-newest', SEEDED_ORGANIZATION_NAME, '2026-03-03T00:00:00.000Z'),
    organization('org-middle', SEEDED_ORGANIZATION_NAME, '2026-03-02T00:00:00.000Z'),
  ];
  const ownerPair = pair(OWNER_EMAIL, ['org-newest', 'org-middle']);
  assert.equal(selectSeededOrganization(rows, ownerPair)?.id, 'org-middle');
});

void test('selectSeededOrganization prefers the owner\u2019s row over an older unrelated one', () => {
  const rows = [
    // Older and same-named, and the pair is a member of it, but the fixture
    // never named this owner in it: a database-wide first match would force
    // the pair into it and relabel it.
    organization('org-unrelated', SEEDED_ORGANIZATION_NAME, '2026-02-01T00:00:00.000Z'),
    organization('org-owned', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
      [FIXTURE_SETTINGS_KEY]: OWNER_EMAIL,
    }),
  ];
  assert.equal(
    selectSeededOrganization(rows, pair(OWNER_EMAIL, ['org-unrelated', 'org-owned']))?.id,
    'org-owned'
  );
});

void test('selectSeededOrganization does not fall back to another owner\u2019s marked row', () => {
  const rows = [
    organization('org-other', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
      [FIXTURE_SETTINGS_KEY]: OTHER_OWNER_EMAIL,
    }),
  ];
  // The two runs share a member, who is in the other owner's organization.
  assert.equal(selectSeededOrganization(rows, pair(OWNER_EMAIL, ['org-other'])), undefined);
});

void test('selectSeededOrganization breaks a created_at tie by id', () => {
  const rows = [
    organization('org-b', `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`, CREATED_AT),
    organization('org-a', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
      [FIXTURE_SETTINGS_KEY]: OWNER_EMAIL,
    }),
  ];
  assert.equal(selectSeededOrganization(rows, pair(OWNER_EMAIL, ['org-a']))?.id, 'org-a');
});

void test('selectSeededOrganization gives each owner its own organization', () => {
  const rows = [
    organization('org-b', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
      [FIXTURE_SETTINGS_KEY]: OTHER_OWNER_EMAIL,
    }),
    organization('org-a', SEEDED_ORGANIZATION_NAME, CREATED_AT, {
      [FIXTURE_SETTINGS_KEY]: OWNER_EMAIL,
    }),
  ];
  assert.equal(selectSeededOrganization(rows, pair(OWNER_EMAIL, ['org-a']))?.id, 'org-a');
  assert.equal(selectSeededOrganization(rows, pair(OTHER_OWNER_EMAIL, ['org-b']))?.id, 'org-b');
});

void test('selectSeededOrganization returns undefined without an organization for this pair', () => {
  assert.equal(selectSeededOrganization([], pair()), undefined);
  assert.equal(
    selectSeededOrganization([organization('org-other', 'Unrelated Org', CREATED_AT)], pair()),
    undefined
  );
  // An unrelated same-named organization is not a candidate, even though a
  // database-wide search used to pick it up.
  assert.equal(
    selectSeededOrganization(
      [organization('org-unrelated', SEEDED_ORGANIZATION_NAME, CREATED_AT)],
      pair()
    ),
    undefined
  );
});

void test('membershipsToPrune prunes only this pair\u2019s memberships outside the kept organization', () => {
  const keepOrganizationId = 'org-keep';
  const ownerUserId = 'user-owner';
  const memberUserId = 'user-member';

  const rows = [
    membership('m1', keepOrganizationId, ownerUserId, SEEDED_ORGANIZATION_NAME),
    membership('m2', keepOrganizationId, memberUserId, SEEDED_ORGANIZATION_NAME),
    membership('m3', 'org-duplicate', ownerUserId, SEEDED_ORGANIZATION_NAME),
    membership(
      'm4',
      'org-duplicate',
      memberUserId,
      `${LEGACY_ORGANIZATION_NAME_PREFIX}${OWNER_EMAIL}`
    ),
    membership('m5', 'org-marked', ownerUserId, 'Renamed Org', {
      [FIXTURE_SETTINGS_KEY]: OWNER_EMAIL,
    }),
    membership('m6', 'org-unrelated', ownerUserId, 'Unrelated Org'),
    membership('m7', 'org-unrelated', memberUserId, 'Unrelated Org'),
    membership('m8', 'org-other-pair', 'someone-else', SEEDED_ORGANIZATION_NAME),
    // Finding 2: a different owner's row is not this pair's, so the pair's
    // membership in it survives.
    membership('m9', 'org-other-pair', ownerUserId, SEEDED_ORGANIZATION_NAME, {
      [FIXTURE_SETTINGS_KEY]: OTHER_OWNER_EMAIL,
    }),
  ];

  const ownerPair = pair(OWNER_EMAIL, [keepOrganizationId, 'org-duplicate', 'org-marked']);
  const pruned = membershipsToPrune(
    rows,
    keepOrganizationId,
    [ownerUserId, memberUserId],
    ownerPair
  );
  assert.deepEqual(
    pruned.map(row => row.id),
    ['m3', 'm4', 'm5']
  );
});

void test('membershipsToPrune returns nothing when the pair only belongs to the kept organization', () => {
  const rows = [
    membership('m1', 'org-keep', 'user-owner', SEEDED_ORGANIZATION_NAME),
    membership('m2', 'org-keep', 'user-member', SEEDED_ORGANIZATION_NAME),
  ];
  assert.deepEqual(
    membershipsToPrune(
      rows,
      'org-keep',
      ['user-owner', 'user-member'],
      pair(OWNER_EMAIL, ['org-keep'])
    ),
    []
  );
});

void test('an organization the owner created under another name stays', () => {
  assert.deepEqual(
    selectSeededOrganizations([seededOrganization('unrelated', 'Real Customer Org', OWNER)], OWNER),
    []
  );
});
