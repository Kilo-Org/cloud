import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSOLETE_STATIC_KEY_PLACEHOLDER_DIGEST,
  inventoryKmsContext,
} from './coding-plan-inventory-credential';

test('binds the data key to the lowercase inventory row id and the Kilo organization', () => {
  assert.deepEqual(inventoryKmsContext('0A1B2C3D-0000-4000-8000-000000000001'), {
    key_id: '0a1b2c3d-0000-4000-8000-000000000001',
    owner_type: 'organization',
    owner_id: '9d278969-5453-4ae3-a51f-a8d2274a7b56',
    provider_id: 'coding-plan-inventory',
  });
});

test('digests the placeholder the way the dual-write release did', () => {
  assert.equal(
    OBSOLETE_STATIC_KEY_PLACEHOLDER_DIGEST,
    '5ec1f7e700f37c3d0b2981d04855fc34b94aaa15457b05ca571817442d228f81'
  );
});
