import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import type { PreviewTargetResult } from '../sandbox/preview-target.js';
import { createControlPlanePreview } from './preview.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';

function metadata(platform: string, sandboxId: string | null = SANDBOX_ID, sessionId = SESSION_ID) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId,
      userId: 'user_1',
      createdOnPlatform: platform,
    },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    workspace:
      sandboxId === null
        ? { sandboxProvider: 'cloudflare' }
        : { sandboxId, sandboxProvider: 'cloudflare' },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

const COORDINATES: PreviewTargetResult = {
  status: 'ok',
  coordinates: {
    provider: 'cloudflare',
    allocationName: SANDBOX_ID,
    containment: false,
  },
};

function fixture(
  input: {
    platform?: string;
    sandboxId?: string | null;
    sessionId?: string;
    result?: PreviewTargetResult;
  } = {}
) {
  const resolveTarget = vi.fn(async () => input.result ?? COORDINATES);
  const preview = createControlPlanePreview({
    getMetadata: () =>
      input.platform === '__missing__' || input.sandboxId === '__missing__'
        ? null
        : metadata(input.platform ?? 'cloud-agent-web', input.sandboxId, input.sessionId),
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

  it('asks the sandbox for coordinates without its own route check', async () => {
    const { preview, resolveTarget } = fixture();
    await expect(preview.resolve()).resolves.toEqual(COORDINATES);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(resolveTarget).toHaveBeenCalledWith(SANDBOX_ID);
  });

  it('passes a sandbox failure result through unchanged', async () => {
    const notRunning: PreviewTargetResult = { status: 'not_running' };
    const { preview } = fixture({ result: notRunning });
    await expect(preview.resolve()).resolves.toEqual(notRunning);
  });
});
