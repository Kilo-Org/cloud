import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveByokKmsConfig } from './byok';

const LOCAL = { url: 'http://127.0.0.1:8901', token: 'dev-byok-kms-token' };

test('falls back to the local service when .env.local leaves both blank', () => {
  assert.deepEqual(resolveByokKmsConfig({}, LOCAL), LOCAL);
  assert.deepEqual(
    resolveByokKmsConfig({ BYOK_KMS_SERVICE_URL: '', BYOK_KMS_SERVICE_TOKEN: '  ' }, LOCAL),
    LOCAL
  );
});

test('keeps configured values and strips trailing slashes', () => {
  assert.deepEqual(
    resolveByokKmsConfig(
      { BYOK_KMS_SERVICE_URL: 'http://127.0.0.1:10701/', BYOK_KMS_SERVICE_TOKEN: 'mine' },
      LOCAL
    ),
    { url: 'http://127.0.0.1:10701', token: 'mine' }
  );
});

test('pairs the dev token with a configured loopback URL', () => {
  assert.deepEqual(
    resolveByokKmsConfig({ BYOK_KMS_SERVICE_URL: 'http://localhost:10701' }, LOCAL),
    { url: 'http://localhost:10701', token: LOCAL.token }
  );
});

test('never sends the dev token to a non-local URL', () => {
  assert.throws(
    () => resolveByokKmsConfig({ BYOK_KMS_SERVICE_URL: 'https://kms.example.com' }, LOCAL),
    /BYOK_KMS_SERVICE_TOKEN is required/
  );
});
