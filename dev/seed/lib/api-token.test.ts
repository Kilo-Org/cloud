import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KILO_API_AUDIENCE,
  LEGACY_API_TOKEN_LIFETIMES_SECONDS,
  isKiloCredentialExchangeEligible,
  signKiloToken,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils';

import { apiTokenSigningParams, DEFAULT_EXPIRES_DAYS } from '../app/api-token';

const TEST_SECRET = 'api-token-shape-test-secret';

// The auth policy (getResourceDelegationAuthority in apps/web) verifies a
// legacy bearer token with `claims.env === process.env.NODE_ENV` and
// `isKiloCredentialExchangeEligible(..., { legacy: 'five-year-api' })` before
// it mints any resource control token. A seed token that misses either check
// made `session.sh cloud-enter` fail with 401/403 and left the device gate
// without its scripted setup scene (2026-09-12, section
// ios-app-terminates-while-remote-session-streams-reasoning).
test('the default seed token carries the shape the policy accepts', async () => {
  const params = apiTokenSigningParams(DEFAULT_EXPIRES_DAYS);

  assert.equal(params.env, 'development');
  assert.ok(
    LEGACY_API_TOKEN_LIFETIMES_SECONDS.some(lifetime => lifetime === params.expiresInSeconds),
    `default lifetime ${params.expiresInSeconds}s must be a legacy five-year API lifetime`
  );

  const { token } = await signKiloToken({
    userId: '00000000-0000-0000-0000-000000000001',
    pepper: 'pepper',
    secret: TEST_SECRET,
    ...params,
  });
  const auth = await verifyKiloTokenForPolicy(token, TEST_SECRET, {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  });

  // The two checks the resource-delegation authority runs on a bearer token.
  assert.equal(auth.claims.env, 'development');
  assert.equal(
    isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' }),
    true,
    'the default seed token must be exchange-eligible so prepareSession accepts it'
  );
});

test('a short-lived dev token is exchange-ineligible (the broken pre-fix shape)', async () => {
  const params = apiTokenSigningParams(7);
  assert.equal(params.expiresInSeconds, 7 * 24 * 60 * 60);
  assert.ok(
    !LEGACY_API_TOKEN_LIFETIMES_SECONDS.some(lifetime => lifetime === params.expiresInSeconds)
  );

  const { token } = await signKiloToken({
    userId: '00000000-0000-0000-0000-000000000001',
    pepper: 'pepper',
    secret: TEST_SECRET,
    ...params,
  });
  const auth = await verifyKiloTokenForPolicy(token, TEST_SECRET, {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  });
  assert.equal(isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' }), false);
});
