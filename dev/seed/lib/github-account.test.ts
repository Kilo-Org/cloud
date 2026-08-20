import assert from 'node:assert/strict';
import test from 'node:test';

import {
  donorRevokedError,
  noDonorAvailableError,
  verificationFailedError,
} from './github-account';

test('donor errors are one line and distinguishable', () => {
  assert.match(noDonorAvailableError().message, /^no donor available:/);
  assert.match(donorRevokedError('octocat', 'github_token_rejected').message, /^donor revoked:/);
  assert.match(donorRevokedError('octocat', 'github_token_rejected').message, /octocat/);
  assert.match(
    verificationFailedError({ connected: false, revoked: true }).message,
    /^verification failed:/
  );
  assert.match(
    verificationFailedError({ connected: false, revoked: true }).message,
    /connected=false revoked=true/
  );
});
