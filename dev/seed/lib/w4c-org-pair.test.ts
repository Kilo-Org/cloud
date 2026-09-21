import assert from 'node:assert/strict';
import test from 'node:test';

import { SEEDED_ORGANIZATION_NAME } from '../app/w4c-org-pair';
import {
  FIXTURE_SETTINGS_KEY,
  FIXTURE_SETTINGS_VALUE,
  isFixtureOrganization,
  LEGACY_ORGANIZATION_NAME_PREFIX,
  membershipsToPrune,
  selectSeededOrganization,
} from './w4c-org-pair';

const CREATED_AT = '2026-03-01T00:00:00.000Z';

function organization(
  id: string,
  name: string,
  created_at: string,
  settings: unknown = {}
): { id: string; name: string; created_at: string; settings: unknown } {
  return { id, name, created_at, settings };
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

// The mobile account sheet renders an organization's name verbatim, so the
// fixture must never hand it a developer marker such as `[seed:w4c-org-pair]`.
void test('the seeded organization name is user-facing, not a developer marker', () => {
  assert.equal(SEEDED_ORGANIZATION_NAME.trim().length > 0, true);
  assert.equal(SEEDED_ORGANIZATION_NAME.includes('[seed:'), false);
});

void test('isFixtureOrganization recognizes the marker, legacy prefix and seeded name', () => {
  assert.equal(isFixtureOrganization(organization('org-name', 'Acme Corp', CREATED_AT)), true);
  assert.equal(
    isFixtureOrganization(
      organization('org-legacy', `${LEGACY_ORGANIZATION_NAME_PREFIX}owner@example.com`, CREATED_AT)
    ),
    true
  );
  assert.equal(
    isFixtureOrganization(
      organization('org-marker', 'Renamed Org', CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: FIXTURE_SETTINGS_VALUE,
      })
    ),
    true
  );
  // `organizations.settings->>'w4c_org_pair'` reads a JSON boolean as 'true'.
  assert.equal(
    isFixtureOrganization(
      organization('org-marker-bool', 'Renamed Org', CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: true,
      })
    ),
    true
  );
});

void test('isFixtureOrganization rejects unrelated organizations', () => {
  assert.equal(
    isFixtureOrganization(organization('org-other', 'Unrelated Org', CREATED_AT)),
    false
  );
  assert.equal(
    isFixtureOrganization(organization('org-similar', 'Acme Corp Ltd', CREATED_AT)),
    false
  );
  assert.equal(
    isFixtureOrganization(
      organization('org-settings', 'Unrelated Org', CREATED_AT, { other: 'true' })
    ),
    false
  );
  assert.equal(
    isFixtureOrganization(
      organization('org-marker-false', 'Unrelated Org', CREATED_AT, {
        [FIXTURE_SETTINGS_KEY]: 'false',
      })
    ),
    false
  );
});

void test('selectSeededOrganization keeps the oldest of the same-named duplicates', () => {
  const rows = [
    organization('org-newest', SEEDED_ORGANIZATION_NAME, '2026-03-03T00:00:00.000Z'),
    organization('org-oldest', SEEDED_ORGANIZATION_NAME, '2026-03-01T00:00:00.000Z'),
    organization('org-middle', SEEDED_ORGANIZATION_NAME, '2026-03-02T00:00:00.000Z'),
  ];
  assert.equal(selectSeededOrganization(rows)?.id, 'org-oldest');
});

void test('selectSeededOrganization breaks a created_at tie by id', () => {
  const rows = [
    organization('org-b', `${LEGACY_ORGANIZATION_NAME_PREFIX}owner@example.com`, CREATED_AT),
    organization('org-a', SEEDED_ORGANIZATION_NAME, CREATED_AT),
  ];
  assert.equal(selectSeededOrganization(rows)?.id, 'org-a');
});

void test('selectSeededOrganization returns undefined without a fixture organization', () => {
  assert.equal(selectSeededOrganization([]), undefined);
  assert.equal(
    selectSeededOrganization([organization('org-other', 'Unrelated Org', CREATED_AT)]),
    undefined
  );
});

void test('membershipsToPrune prunes only the pair fixture memberships outside the kept organization', () => {
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
      `${LEGACY_ORGANIZATION_NAME_PREFIX}owner@example.com`
    ),
    membership('m5', 'org-marked', ownerUserId, 'Renamed Org', {
      [FIXTURE_SETTINGS_KEY]: FIXTURE_SETTINGS_VALUE,
    }),
    membership('m6', 'org-unrelated', ownerUserId, 'Unrelated Org'),
    membership('m7', 'org-unrelated', memberUserId, 'Unrelated Org'),
    membership('m8', 'org-other-pair', 'someone-else', SEEDED_ORGANIZATION_NAME),
  ];

  const pruned = membershipsToPrune(rows, keepOrganizationId, [ownerUserId, memberUserId]);
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
  assert.deepEqual(membershipsToPrune(rows, 'org-keep', ['user-owner', 'user-member']), []);
});
