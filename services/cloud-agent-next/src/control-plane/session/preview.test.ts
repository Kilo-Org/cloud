import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import type { PreviewSandboxScope, PreviewTargetResult } from '../sandbox/preview-target.js';
import { createControlPlanePreview } from './preview.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const WORKTREE_ID = 'worktree_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';

function metadata(input: {
  platform: string;
  sandboxId?: string | null;
  sessionId?: string;
  worktreeId?: string;
  orgId?: string;
}) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId ?? SESSION_ID,
      userId: 'user_1',
      createdOnPlatform: input.platform,
      ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    workspace:
      input.sandboxId === null
        ? { sandboxProvider: 'cloudflare' }
        : {
            sandboxId: input.sandboxId ?? SANDBOX_ID,
            sandboxProvider: 'cloudflare',
            ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
          },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

const COORDINATES: PreviewTargetResult = {
  status: 'ok',
  coordinates: {
    provider: 'cloudflare-containers',
    logicalSandboxId: SESSION_ID,
    allocationRef: SANDBOX_ID,
  },
};

function scope(overrides: Partial<PreviewSandboxScope> = {}): PreviewSandboxScope {
  return {
    ownerId: 'user_1',
    organizationId: null,
    scopeId: SESSION_ID,
    ...overrides,
  };
}

function fixture(
  input: {
    platform?: string;
    sandboxId?: string | null;
    sessionId?: string;
    worktreeId?: string;
    orgId?: string;
    result?: PreviewTargetResult;
  } = {}
) {
  const resolveTarget = vi.fn(
    async (_sandboxId: string, _scope: PreviewSandboxScope) => input.result ?? COORDINATES
  );
  const preview = createControlPlanePreview({
    getMetadata: () =>
      input.platform === '__missing__' || input.sandboxId === '__missing__'
        ? null
        : metadata({
            platform: input.platform ?? 'cloud-agent-web',
            ...(input.sandboxId === undefined ? {} : { sandboxId: input.sandboxId }),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
            ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
          }),
    resolveTarget,
  });
  return { preview, resolveTarget };
}

describe('V2 control-plane preview resolver', () => {
  it('rejects a non-interactive platform as ineligible', async () => {
    const { preview, resolveTarget } = fixture({ platform: 'api' });
    await expect(preview.resolve()).resolves.toEqual({ status: 'ineligible' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('rejects a non-workspace session as ineligible', async () => {
    const { preview, resolveTarget } = fixture({
      sessionId: 'agent_11111111-1111-4111-8111-111111111111',
    });
    await expect(preview.resolve()).resolves.toEqual({ status: 'ineligible' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it.each(['desktop', 'agent-manager'])(
    'allows preview for an inherited %s hosted worktree session',
    async platform => {
      const { preview, resolveTarget } = fixture({ platform, worktreeId: WORKTREE_ID });
      await expect(preview.resolve()).resolves.toEqual(COORDINATES);
      expect(resolveTarget).toHaveBeenCalledWith(SANDBOX_ID, scope({ scopeId: WORKTREE_ID }));
    }
  );

  it('uses the session id as the scope for a session without a hosted worktree', async () => {
    const { preview, resolveTarget } = fixture();
    await expect(preview.resolve()).resolves.toEqual(COORDINATES);
    expect(resolveTarget).toHaveBeenCalledWith(SANDBOX_ID, scope());
  });

  it('passes the stored organization into the sandbox scope', async () => {
    const { preview, resolveTarget } = fixture({ orgId: 'org_1' });
    await expect(preview.resolve()).resolves.toEqual(COORDINATES);
    expect(resolveTarget).toHaveBeenCalledWith(SANDBOX_ID, scope({ organizationId: 'org_1' }));
  });

  it('rejects a native desktop session without a hosted worktree', async () => {
    const { preview, resolveTarget } = fixture({ platform: 'desktop' });
    await expect(preview.resolve()).resolves.toEqual({ status: 'ineligible' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('returns not_ready without metadata', async () => {
    const { preview, resolveTarget } = fixture({ platform: '__missing__' });
    await expect(preview.resolve()).resolves.toEqual({ status: 'not_ready' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('returns not_ready before a sandbox is assigned', async () => {
    const { preview, resolveTarget } = fixture({ sandboxId: null });
    await expect(preview.resolve()).resolves.toEqual({ status: 'not_ready' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('asks the sandbox for coordinates for the resolved workspace scope', async () => {
    const { preview, resolveTarget } = fixture({ worktreeId: WORKTREE_ID });
    await expect(preview.resolve()).resolves.toEqual(COORDINATES);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(resolveTarget).toHaveBeenCalledWith(SANDBOX_ID, scope({ scopeId: WORKTREE_ID }));
  });

  it('passes a sandbox failure result through unchanged', async () => {
    const notRunning: PreviewTargetResult = { status: 'not_running' };
    const { preview } = fixture({ result: notRunning });
    await expect(preview.resolve()).resolves.toEqual(notRunning);
  });
});
