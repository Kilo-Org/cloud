import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import type * as SandboxIdModule from '../sandbox-id.js';

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  findWrapperForSession: vi.fn(),
  fetchSessionMetadata: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));
vi.mock('../kilo/wrapper-manager.js', () => ({
  findWrapperForSession: mocks.findWrapperForSession,
}));
vi.mock('../session-service.js', () => ({ fetchSessionMetadata: mocks.fetchSessionMetadata }));
vi.mock('../sandbox-id.js', async importOriginal => ({
  ...(await importOriginal<typeof SandboxIdModule>()),
  generateSandboxId: vi.fn(),
  getSandboxNamespace: vi.fn().mockReturnValue({}),
}));

import { resolveLiveWrapperTarget } from './session-proxy.js';

const metadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'agent_facade',
    userId: 'user_facade',
    orgId: 'org_facade',
  },
  auth: { kiloSessionId: 'kilo_facade' },
  lifecycle: { version: 1, timestamp: 1 },
  workspace: {
    sandboxId: 'ses-facade',
    sandboxProvider: 'cloudflare',
    workspacePath: '/workspace/facade',
    sessionHome: '/home/agent_facade',
    branchName: 'main',
  },
} satisfies SessionMetadata;

describe('resolveLiveWrapperTarget billing admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchSessionMetadata.mockResolvedValue(metadata);
  });

  it('does not inspect a selected live wrapper when paid admission is rejected', async () => {
    const ensureBillingAdmission = vi.fn().mockResolvedValue({
      success: false,
      code: 'insufficient_credits',
      message: 'Low balance',
    });
    mocks.getSandbox.mockReturnValue({
      isBillingBlocked: vi.fn().mockResolvedValue(false),
      ensureBillingAdmission,
    });

    await expect(
      resolveLiveWrapperTarget({
        env: {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
          CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
          CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org_facade',
        } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).resolves.toEqual({
      kind: 'billing-rejected',
      admission: {
        success: false,
        code: 'insufficient_credits',
        message: 'Low balance',
      },
    });
    expect(ensureBillingAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 'ses-facade',
        subject: { type: 'org', id: 'org_facade' },
        actor: { type: 'user', id: 'user_facade' },
        enforcementRequested: true,
      })
    );
    expect(mocks.findWrapperForSession).not.toHaveBeenCalled();
  });

  it('answers a control-plane session as unavailable without waking its sandbox', async () => {
    await expect(
      resolveLiveWrapperTarget({
        env: {} as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'workspace_facade',
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(mocks.fetchSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(mocks.findWrapperForSession).not.toHaveBeenCalled();
  });

  it('allows shadow acquisition when the billing block method is unavailable', async () => {
    mocks.getSandbox.mockReturnValue({});
    mocks.findWrapperForSession.mockResolvedValue({ port: 5000 });

    await expect(
      resolveLiveWrapperTarget({
        env: {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false',
          CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
          CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: '',
        } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).resolves.toMatchObject({ kind: 'available', target: { port: 5000 } });
  });

  it('retries shadow configuration and inspects the wrapper through the recovered handle', async () => {
    const error = Object.assign(new Error('Durable Object reset'), { retryable: true });
    const failed = { configureBilling: vi.fn().mockRejectedValue(error) };
    const recovered = { configureBilling: vi.fn().mockResolvedValue(undefined) };
    mocks.getSandbox
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(failed)
      .mockReturnValue(recovered);
    mocks.findWrapperForSession.mockResolvedValue({ port: 5000 });

    await expect(
      resolveLiveWrapperTarget({
        env: { CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false' } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).resolves.toEqual({ kind: 'available', target: { sandbox: recovered, port: 5000 } });

    expect(mocks.getSandbox).toHaveBeenCalledTimes(3);
    expect(failed.configureBilling).toHaveBeenCalledOnce();
    expect(recovered.configureBilling).toHaveBeenCalledWith(
      failed.configureBilling.mock.calls[0][0]
    );
    expect(mocks.findWrapperForSession).toHaveBeenCalledWith(recovered, 'agent_facade');
  });

  it('does not inspect the wrapper when shadow configuration retries are exhausted', async () => {
    const error = Object.assign(new Error('Durable Object reset'), { retryable: true });
    const configureBilling = vi.fn().mockRejectedValue(error);
    mocks.getSandbox.mockImplementation(() => ({ configureBilling }));

    await expect(
      resolveLiveWrapperTarget({
        env: { CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false' } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).rejects.toBe(error);

    expect(configureBilling).toHaveBeenCalledTimes(3);
    expect(mocks.getSandbox).toHaveBeenCalledTimes(4);
    expect(mocks.findWrapperForSession).not.toHaveBeenCalled();
  });

  it('allows shadow acquisition when the callable billing block proxy rejects', async () => {
    mocks.getSandbox.mockReturnValue({
      isBillingBlocked: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    });
    mocks.findWrapperForSession.mockResolvedValue({ port: 5000 });

    await expect(
      resolveLiveWrapperTarget({
        env: {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false',
          CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
          CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: '',
        } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).resolves.toMatchObject({ kind: 'available', target: { port: 5000 } });
  });

  it('fails enforced acquisition closed when the callable billing block proxy rejects', async () => {
    const ensureBillingAdmission = vi.fn().mockResolvedValue({
      success: false,
      code: 'meter_unavailable',
      message: 'Container billing admission is unavailable',
    });
    mocks.getSandbox.mockReturnValue({
      isBillingBlocked: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
      ensureBillingAdmission,
    });

    await expect(
      resolveLiveWrapperTarget({
        env: {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
          CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
          CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org_facade',
        } as Env,
        userId: 'user_facade',
        cloudAgentSessionId: 'agent_facade',
      })
    ).resolves.toMatchObject({
      kind: 'billing-rejected',
      admission: { code: 'meter_unavailable' },
    });
    expect(ensureBillingAdmission).toHaveBeenCalledOnce();
    expect(mocks.findWrapperForSession).not.toHaveBeenCalled();
  });
});
