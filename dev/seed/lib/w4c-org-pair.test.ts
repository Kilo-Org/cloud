import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectSeededOrganizations,
  SEEDED_ORGANIZATION_NAME,
  type SeededOrganizationRow,
} from '../app/w4c-org-pair';

const OWNER = 'owner-user-id';
const OTHER_OWNER = 'other-user-id';

function organization(
  id: string,
  name: string,
  createdByUserId: string | null
): SeededOrganizationRow {
  return { id, name, createdByUserId };
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
    organization(`legacy-${index}`, '[seed:w4c-org-pair] owner@example.com', null)
  );

  const selected = selectSeededOrganizations(accumulated, OWNER);

  assert.equal(selected.length, 13);

  // A rerun deletes what it selected and inserts one organization: the sheet
  // then lists the pair once, whatever earlier rounds left.
  const rerun = [
    ...accumulated.filter(row => !selected.includes(row)),
    organization('current', SEEDED_ORGANIZATION_NAME, OWNER),
  ];
  assert.deepEqual(selectSeededOrganizations(rerun, OWNER), [
    organization('current', SEEDED_ORGANIZATION_NAME, OWNER),
  ]);
});

// The current fixture name is user-facing, so it identifies the fixture's own
// rows through the account that created them, and through the rows an earlier
// run left without a creator (the fixture only records one since the reset).
void test('the current name counts for the owner and for a pre-reset row', () => {
  assert.deepEqual(
    selectSeededOrganizations([organization('mine', SEEDED_ORGANIZATION_NAME, OWNER)], OWNER),
    [organization('mine', SEEDED_ORGANIZATION_NAME, OWNER)]
  );
  assert.deepEqual(
    selectSeededOrganizations([organization('pre-reset', SEEDED_ORGANIZATION_NAME, null)], OWNER),
    [organization('pre-reset', SEEDED_ORGANIZATION_NAME, null)]
  );
});

// A name match alone never selects another account's row.
void test("another account's organization of the same name stays", () => {
  assert.deepEqual(
    selectSeededOrganizations(
      [organization('theirs', SEEDED_ORGANIZATION_NAME, OTHER_OWNER)],
      OWNER
    ),
    []
  );
});

void test('an organization the owner created under another name stays', () => {
  assert.deepEqual(
    selectSeededOrganizations([organization('unrelated', 'Real Customer Org', OWNER)], OWNER),
    []
  );
});
