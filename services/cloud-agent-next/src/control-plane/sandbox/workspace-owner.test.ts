import { describe, expect, it, vi } from 'vitest';
import {
  recoverHistoricalWorkspaceOwner,
  sameSandboxWorkspaceOwner,
  workspaceOwnerFromRoute,
} from './workspace-owner.js';
import { hashToSandboxId } from '../../sandbox-id.js';
import { ISOLATED_CONTAINER_WORKSPACE_PATH } from '../../workspace.js';
import type { ControlPlaneCredentialSource } from '../../shared/control-plane-protocol.js';

const WORKSPACE = 'worktree_11111111-1111-4111-8111-111111111111';
const spec = { sessionId: 'workspace_parent', directory: '/workspace/app' };
const source = {
  userId: 'user',
  orgId: 'org',
  kiloSessionId: 'ses_1',
  kiloToken: 'token',
  workspaceId: WORKSPACE,
  scopeId: WORKSPACE,
} satisfies ControlPlaneCredentialSource;

describe('sandbox workspace identity', () => {
  it('identifies siblings by workspace rather than chat', () => {
    expect(
      sameSandboxWorkspaceOwner(
        workspaceOwnerFromRoute(spec, source),
        workspaceOwnerFromRoute({ ...spec, sessionId: 'workspace_sibling' }, source)
      )
    ).toBe(true);
  });

  it.each([
    { ...source, orgId: undefined },
    { ...source, orgId: 'other-org' },
    { ...source, userId: 'other-user' },
  ])('does not conflate owner or organization with %j', candidate => {
    expect(
      sameSandboxWorkspaceOwner(
        workspaceOwnerFromRoute(spec, source),
        workspaceOwnerFromRoute(spec, candidate)
      )
    ).toBe(false);
  });

  it('requires registered workspace identity for new admission', () => {
    expect(() => workspaceOwnerFromRoute(spec, { ...source, workspaceId: undefined })).toThrow(
      'Sandbox workspace identity is required'
    );
    expect(() => workspaceOwnerFromRoute(spec, { ...source, scopeId: 'other' })).toThrow(
      'Sandbox workspace identity is required'
    );
  });

  it('recognizes historical worktree scope and standalone records explicitly', () => {
    expect(workspaceOwnerFromRoute(spec, { ...source, workspaceId: undefined }, true)).toEqual(
      workspaceOwnerFromRoute(spec, source)
    );
    expect(
      workspaceOwnerFromRoute(
        spec,
        { ...source, workspaceId: undefined, scopeId: spec.sessionId },
        true
      )
    ).toMatchObject({ kind: 'standalone', workspaceId: spec.sessionId });
    expect(() =>
      workspaceOwnerFromRoute(spec, { ...source, workspaceId: undefined, scopeId: 'user' }, true)
    ).toThrow('Sandbox workspace identity is required');
  });
});

describe('historical route-less workspace ownership', () => {
  const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
  const workspace = { workspaceId: WORKSPACE, userId: 'user', organizationId: 'org' };

  it.each(['sbx', 'ses', 'istd'])(
    'requires both deterministic %s placement and authenticated catalog ownership',
    async prefix => {
      const sandboxId = await hashToSandboxId(
        prefix === 'sbx' ? `control-isolated-v1:${sessionId}` : sessionId,
        prefix
      );
      const readWorkspace = vi.fn().mockResolvedValue(workspace);
      expect(
        await recoverHistoricalWorkspaceOwner({
          sandboxId,
          sandboxKind: prefix === 'sbx' ? 'isolated' : undefined,
          userId: 'user',
          workspaceId: WORKSPACE,
          readWorkspace,
        })
      ).toEqual({
        kind: 'workspace',
        workspaceId: WORKSPACE,
        userId: 'user',
        orgId: 'org',
        directory: ISOLATED_CONTAINER_WORKSPACE_PATH,
      });
      expect(readWorkspace).toHaveBeenCalledWith(WORKSPACE);
    }
  );

  it('does not use a valid catalog workspace to claim another workspace sandbox', async () => {
    const readWorkspace = vi.fn().mockResolvedValue(workspace);
    expect(
      await recoverHistoricalWorkspaceOwner({
        sandboxId: await hashToSandboxId('another-session', 'ses'),
        userId: 'user',
        workspaceId: WORKSPACE,
        readWorkspace,
      })
    ).toBeUndefined();
    expect(readWorkspace).not.toHaveBeenCalled();
  });

  it.each([null, { ...workspace, userId: 'another-user' }])(
    'does not accept logical placement without matching authenticated evidence: %j',
    async proof => {
      expect(
        await recoverHistoricalWorkspaceOwner({
          sandboxId: await hashToSandboxId(sessionId, 'ses'),
          userId: 'user',
          workspaceId: WORKSPACE,
          readWorkspace: async () => proof,
        })
      ).toBeUndefined();
    }
  );
});
