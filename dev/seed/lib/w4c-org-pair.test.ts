import assert from 'node:assert/strict';
import test from 'node:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { SEEDED_ORGANIZATION_NAME, w4cOrgPairCleanupCondition } from '../app/w4c-org-pair';

// The mobile account sheet renders an organization's name verbatim, so the
// fixture must never hand it a developer marker such as `[seed:w4c-org-pair]`.
void test('the seeded organization name is user-facing, not a developer marker', () => {
  assert.equal(SEEDED_ORGANIZATION_NAME.trim().length > 0, true);
  assert.equal(SEEDED_ORGANIZATION_NAME.includes('[seed:'), false);
});

// The pre-PR seed inserted `{ id, name }` only, so every row a rerun of it wrote
// has a NULL `created_by_kilo_user_id`. The cleanup must therefore identify those
// rows by the owner membership, not by the creator column.
void test('cleanup condition matches pre-PR rows through the owner membership, not the creator', () => {
  const ownerEmail = 'owner@example.com';
  const ownerUserId = 'usr_owner';
  const { sql, params } = new PgDialect().sqlToQuery(
    w4cOrgPairCleanupCondition(ownerEmail, ownerUserId)
  );

  assert.equal(sql.includes('created_by_kilo_user_id'), false);
  assert.equal(sql.includes('"organization_memberships"."kilo_user_id"'), true);
  assert.equal(sql.includes('"organization_memberships"."role"'), true);
  assert.equal(params.includes(ownerUserId), true);
  assert.equal(params.includes('owner'), true);
});

void test('cleanup condition still matches both fixture names for that owner', () => {
  const { params } = new PgDialect().sqlToQuery(
    w4cOrgPairCleanupCondition('owner@example.com', 'usr_owner')
  );

  assert.equal(params.includes('[seed:w4c-org-pair] owner@example.com'), true);
  assert.equal(params.includes(SEEDED_ORGANIZATION_NAME), true);
});
