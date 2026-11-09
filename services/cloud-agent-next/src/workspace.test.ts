import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import { describe, expect, it } from 'vitest';
import {
  getBaseWorkspacePath,
  getSessionWorkspacePath,
  getWorktreeWorkspacePath,
  getControlPlaneSessionDirectory,
  sanitizeIdForPath,
  ISOLATED_CONTAINER_WORKSPACE_PATH,
} from './workspace.js';

describe('workspace path construction', () => {
  const ORG_ID = '33c8c114-791f-463c-9f7f-fe74b284cfcf';
  const BOT_USER_ID = `bot-code-review-${ORG_ID}`;
  const SESSION_ID = 'agent_420ae020-e3c4-4e67-878b-66672c3d997e';
  const WORKTREE_ID = 'worktree_420ae020-e3c4-4e67-878b-66672c3d997e';

  it('builds owner-scoped canonical worktree paths for personal and organization sessions', () => {
    expect(getWorktreeWorkspacePath(undefined, 'user-1', WORKTREE_ID)).toBe(
      `/workspace/user-1/worktrees/${WORKTREE_ID}`
    );
    expect(getWorktreeWorkspacePath(ORG_ID, 'user-1', WORKTREE_ID)).toBe(
      `/workspace/${ORG_ID}/user-1/worktrees/${WORKTREE_ID}`
    );
  });

  it('preserves arbitrary OAuth user IDs in canonical worktree paths', () => {
    expect(getWorktreeWorkspacePath(ORG_ID, 'oauth/google:1234', WORKTREE_ID)).toBe(
      `/workspace/${ORG_ID}/oauth-google-1234/worktrees/${WORKTREE_ID}`
    );
  });

  it.each([
    '',
    'worktree_invalid',
    'worktree_../../outside',
    'worktree_420ae020-e3c4-4e67-878b-66672c3d997e/child',
    'workspace_420ae020-e3c4-4e67-878b-66672c3d997e',
  ])('rejects unsafe worktree ID %s before constructing a path', worktreeId => {
    expect(() =>
      getWorktreeWorkspacePath(ORG_ID, 'user-1', worktreeId as CloudAgentWorktreeId)
    ).toThrow(/invalid worktree id/);
  });

  it('keeps the userId segment between the org and the sessions directory', () => {
    // Dropping this segment would yield `/workspace/<orgId>/sessions/<sessionId>`,
    // which is indistinguishable in shape from a legitimate personal-account
    // workspace and so reads as valid, but for an org session points at a
    // directory that does not exist and is outside the external_directory
    // allowlist. No caller has been observed passing an empty userId; this is a
    // guard, not a repair.
    expect(getSessionWorkspacePath(ORG_ID, BOT_USER_ID, SESSION_ID)).toBe(
      `/workspace/${ORG_ID}/${BOT_USER_ID}/sessions/${SESSION_ID}`
    );
  });

  it('omits the org segment for personal accounts', () => {
    expect(getSessionWorkspacePath(undefined, 'user-1', SESSION_ID)).toBe(
      `/workspace/user-1/sessions/${SESSION_ID}`
    );
  });

  it.each([
    ['undefined', undefined],
    // Absence may arrive as null if the metadata schemas ever move to nullish();
    // that must stay a personal account, not a hard failure on every resume.
    ['null', null],
  ])('omits the org segment when the org id is %s', (_label, orgId) => {
    expect(getBaseWorkspacePath(orgId, 'user-1')).toBe('/workspace/user-1');
  });

  it.each([
    ['a blank org id', '   '],
    ['an empty org id', ''],
    ['a relative org id', '..'],
  ])('throws on %s instead of falling back to the personal namespace', (_label, orgId) => {
    // A supplied-but-unusable org id is corruption, not a personal account.
    // Falling back would put an org session's workspace, allowlist, and cleanup
    // root under /workspace/<userId> and still look like it worked.
    expect(() => getBaseWorkspacePath(orgId, 'user-1')).toThrow(/invalid organization id/);
  });

  it('replaces path separators in federated user ids', () => {
    expect(sanitizeIdForPath('oauth/google:1234')).toBe('oauth-google-1234');
    expect(getBaseWorkspacePath(ORG_ID, 'oauth/google:1234')).toBe(
      `/workspace/${ORG_ID}/oauth-google-1234`
    );
  });

  it.each([
    ['an empty userId', ''],
    ['a whitespace userId', '   '],
    ['a relative userId', '..'],
  ])('throws on %s instead of collapsing the path', (_label, userId) => {
    expect(() => getSessionWorkspacePath(ORG_ID, userId, SESSION_ID)).toThrow(/invalid userId/);
  });

  it.each([
    ['a blank session id', ''],
    ['a session id containing a separator', 'agent_x/y'],
    ['a padded session id', ` ${SESSION_ID} `],
  ])('throws on %s', (_label, sessionId) => {
    expect(() => getSessionWorkspacePath(ORG_ID, BOT_USER_ID, sessionId)).toThrow(
      /invalid session id/
    );
  });

  it('uses the isolated container directory for isolated single-session sandboxes', () => {
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: undefined,
        sandboxId: 'ses-0123456789abcdef',
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(ISOLATED_CONTAINER_WORKSPACE_PATH);
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: undefined,
        sandboxId: 'istd-0123456789abcdef',
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(ISOLATED_CONTAINER_WORKSPACE_PATH);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['shared', `usr-${'a'.repeat(48)}`],
    ['code-review', `crv-${'a'.repeat(48)}`],
    ['devcontainer', `dind-${'a'.repeat(48)}`],
  ])('falls back to the per-session path when the sandbox id is %s', (_label, sandboxId) => {
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: undefined,
        sandboxId,
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(getSessionWorkspacePath(ORG_ID, 'user-1', SESSION_ID));
  });

  it.each([
    ['isolated', true],
    ['code-review', false],
    ['shared', false],
  ] as const)('resolves a placed %s sandbox directory from its kind', (sandboxKind, isolated) => {
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: undefined,
        sandboxId: `sbx-${'a'.repeat(48)}`,
        sandboxKind,
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(
      isolated
        ? ISOLATED_CONTAINER_WORKSPACE_PATH
        : getSessionWorkspacePath(ORG_ID, 'user-1', SESSION_ID)
    );
  });

  it('rejects a placed sandbox key without its kind', () => {
    expect(() =>
      getControlPlaneSessionDirectory({
        workspacePath: undefined,
        sandboxId: `sbx-${'a'.repeat(48)}`,
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toThrow('Sandbox key and kind do not match');
  });

  it('uses the isolated container directory over an explicit worktree path', () => {
    const explicit = getWorktreeWorkspacePath(ORG_ID, 'user-1', WORKTREE_ID);
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: explicit,
        sandboxId: 'ses-0123456789abcdef',
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(ISOLATED_CONTAINER_WORKSPACE_PATH);
  });

  it.each([
    ['shared', `usr-${'a'.repeat(48)}`],
    ['code-review', `crv-${'a'.repeat(48)}`],
    ['devcontainer', `dind-${'a'.repeat(48)}`],
  ])('keeps an explicit worktree path on a %s sandbox', (_label, sandboxId) => {
    const explicit = getWorktreeWorkspacePath(ORG_ID, 'user-1', WORKTREE_ID);
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: explicit,
        sandboxId,
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(explicit);
  });

  it('treats an empty workspace path as explicit on a shared sandbox but not on an isolated one', () => {
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: '',
        sandboxId: `usr-${'a'.repeat(48)}`,
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe('');
    expect(
      getControlPlaneSessionDirectory({
        workspacePath: '',
        sandboxId: 'ses-0123456789abcdef',
        orgId: ORG_ID,
        userId: 'user-1',
        sessionId: SESSION_ID,
      })
    ).toBe(ISOLATED_CONTAINER_WORKSPACE_PATH);
  });
});
