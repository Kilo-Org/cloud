import assert from 'node:assert/strict';
import test from 'node:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { SEEDED_ORGANIZATION_NAME, w4cOrgPairCleanupCondition } from '../app/w4c-org-pair';
import { w4cOrgPairName, w4cOrgPairOrganizationId } from './w4c-org-pair-fixture';

const ownerEmail = 'owner@example.com';

// The mobile account sheet renders an organization's name verbatim, so the
// fixture must never hand it a developer marker such as `[seed:w4c-org-pair]`.
void test('the seeded organization name is user-facing, not a developer marker', () => {
  assert.equal(SEEDED_ORGANIZATION_NAME.trim().length > 0, true);
  assert.equal(SEEDED_ORGANIZATION_NAME.includes('[seed:'), false);
});

// Cleanup must target the row this fixture wrote, not every organization that
// happens to carry the display name. The deterministic id is that identity.
void test('cleanup condition matches the fixture through its deterministic organization id', () => {
  const { params } = new PgDialect().sqlToQuery(w4cOrgPairCleanupCondition(ownerEmail));

  assert.equal(params.includes(w4cOrgPairOrganizationId(ownerEmail)), true);
});

// The pre-PR seed named orgs `[seed:w4c-org-pair] <owner-email>`; those rows are
// still cleaned by that fixture-specific name, which embeds the owner email.
void test('cleanup condition matches the legacy fixture name for that owner', () => {
  const { params } = new PgDialect().sqlToQuery(w4cOrgPairCleanupCondition(ownerEmail));

  assert.equal(params.includes(w4cOrgPairName(ownerEmail)), true);
});

// A user-owned organization named `Acme Corp` is ordinary and must survive a
// seed rerun; only fixture-specific identifiers may select a row for deletion.
void test('cleanup condition never selects a row by the generic display name', () => {
  const { sql, params } = new PgDialect().sqlToQuery(w4cOrgPairCleanupCondition(ownerEmail));

  assert.equal(params.includes(SEEDED_ORGANIZATION_NAME), false);
  assert.equal(params.includes('%'), false);
  assert.equal(sql.includes('created_by_kilo_user_id'), false);
});

void test('cleanup conditions for different owners never overlap', () => {
  const other = 'other@example.com';
  const { params } = new PgDialect().sqlToQuery(w4cOrgPairCleanupCondition(ownerEmail));

  assert.equal(params.includes(w4cOrgPairOrganizationId(other)), false);
  assert.equal(params.includes(w4cOrgPairName(other)), false);
});
