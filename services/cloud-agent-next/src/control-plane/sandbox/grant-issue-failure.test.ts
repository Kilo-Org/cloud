import { describe, expect, it } from 'vitest';
import { EnvironmentMemberCredentialError } from '../../sandbox-control/session-credential-members.js';
import { SessionCredentialUpgradeRequiredError } from '../../sandbox-control/session-credentials.js';
import { grantIssueFailure } from './routes.js';
import {
  MixedCredentialClassError,
  ScopeHandleConflictError,
  ScopeMemberLimitError,
} from './scope-handle-adoption.js';

// `startAttempt` and the restart re-bind in the Sandbox DO both fail a route
// through this one mapping, so it fixes what the user and the diagnostics see.
describe('grantIssueFailure', () => {
  it('fails a member that cannot be issued with its own reason and a stage that names it', () => {
    const error = new EnvironmentMemberCredentialError('acme/gadgets', {
      cause: new Error('GitHub capability issuance is unavailable'),
    });

    expect(grantIssueFailure(error, 'credential_grant_failed')).toEqual({
      reason: 'repository_access_failed',
      stage: 'member_credential_failed:acme_gadgets',
    });
    expect(grantIssueFailure(error, 'runtime_proxy_bind_failed').reason).toBe(
      'repository_access_failed'
    );
  });

  it('keeps the credential upgrade reason', () => {
    expect(
      grantIssueFailure(new SessionCredentialUpgradeRequiredError(), 'credential_grant_failed')
    ).toEqual({
      reason: 'credential_upgrade_required',
      stage: 'credential_upgrade_required',
    });
  });

  it.each([
    [new ScopeMemberLimitError(), 'scope_member_limit'],
    [new MixedCredentialClassError(), 'mixed_credential_class'],
    [new ScopeHandleConflictError(), 'scope_handle_conflict'],
  ])('keeps the admission stage of %s', (error, stage) => {
    expect(grantIssueFailure(error, 'credential_grant_failed')).toEqual({
      reason: 'workspace_setup_failed',
      stage,
    });
  });

  it('gives any other error, a timeout included, the generic reason and the caller stage', () => {
    // A timeout bounds the whole grant, so it cannot name the member that was slow.
    expect(
      grantIssueFailure(new Error('Credential binding timed out'), 'runtime_proxy_bind_failed')
    ).toEqual({
      reason: 'workspace_setup_failed',
      stage: 'runtime_proxy_bind_failed',
    });
  });

  it('does not put the upstream error text in the stage', () => {
    const error = new EnvironmentMemberCredentialError('acme/gadgets', {
      cause: new Error('token ghs_secret rejected'),
    });
    expect(grantIssueFailure(error, 'credential_grant_failed').stage).not.toContain('ghs_secret');
  });
});
