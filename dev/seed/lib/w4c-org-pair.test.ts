import assert from 'node:assert/strict';
import test from 'node:test';

import { SEEDED_ORGANIZATION_NAME } from '../app/w4c-org-pair';

// The mobile account sheet renders an organization's name verbatim, so the
// fixture must never hand it a developer marker such as `[seed:w4c-org-pair]`.
void test('the seeded organization name is user-facing, not a developer marker', () => {
  assert.equal(SEEDED_ORGANIZATION_NAME.trim().length > 0, true);
  assert.equal(SEEDED_ORGANIZATION_NAME.includes('[seed:'), false);
});
