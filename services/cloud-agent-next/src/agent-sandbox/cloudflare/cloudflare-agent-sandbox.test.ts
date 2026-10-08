import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env, SandboxInstance } from '../../types.js';
import { getSandbox } from '@cloudflare/sandbox';
import type { CredentialContainment, SessionMetadata } from '../../persistence/session-metadata.js';
import { WrapperClient } from '../../kilo/wrapper-client.js';
import { WRAPPER_VERSION } from '../../shared/wrapper-version.js';
import type { EnsureWrapperRequest } from '../protocol.js';
import { CloudflareAgentSandbox } from './cloudflare-agent-sandbox.js';
import {
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
} from '../../workspace-errors.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

type TestSandboxId = NonNullable<SessionMetadata['workspace']>['sandboxId'];

function metadata(options?: {
  devcontainer?: boolean;
  githubRepo?: string;
  sandboxId?: TestSandboxId;
  credentialContainment?: CredentialContainment;
}): SessionMetadata {
  const sandboxId = options?.sandboxId ?? (options?.devcontainer ? 'dind-abcdef' : 'ses-abcdef');
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_cloudflare', userId: 'user_cloudflare', orgId: 'org_cloudflare' },
    auth: {},
    workspace: {
      sandboxId,
      ...(options?.credentialContainment
        ? { credentialContainment: options.credentialContainment }
        : {}),
    },
    ...(options?.githubRepo
      ? { repository: { type: 'github' as const, repo: options.githubRepo } }
      : {}),
    ...(options?.devcontainer
      ? {
          devcontainer: {
            workspacePath: '/workspace/cloudflare',
            innerWorkspaceFolder: '/workspaces/repo',
            wrapperPort: 4173,
            configPath: '.devcontainer/devcontainer.json',
          },
        }
      : {}),
    lifecycle: { version: 1, timestamp: 1 },
  };
}

function ensureRequest(options?: {
  devcontainer?: boolean;
  leased?: boolean;
  githubRepo?: string;
  sandboxId?: TestSandboxId;
}): EnsureWrapperRequest {
  const sandboxId = options?.sandboxId ?? (options?.devcontainer ? 'dind-abcdef' : 'ses-abcdef');
  const sessionMetadata = metadata({
    devcontainer: options?.devcontainer,
    githubRepo: options?.githubRepo,
    sandboxId: options?.sandboxId,
  });
  return {
    plan: {
      scope: { sessionId: 'agent_cloudflare', userId: 'user_cloudflare', orgId: 'org_cloudflare' },
      turn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bCloudflareAAAA',
        prompt: 'Run in Cloudflare',
      },
      agent: { mode: 'code', model: 'test-model' },
      workspace: { sandboxId, metadata: sessionMetadata },
      wrapper: {
        kiloSessionId: 'kilo_cloudflare',
        fence: {
          wrapperRunId: 'wr_cloudflare',
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_cloudflare',
        },
      },
    },
    ...(options?.leased
      ? { leasedInstance: { instanceId: 'instance_cloudflare', instanceGeneration: 3 } }
      : {}),
    prepared: {
      ready: {
        workspacePath: '/workspace/cloudflare',
        sandboxId,
        sessionHome: '/home/agent_cloudflare',
        branchName: 'session/agent_cloudflare',
        kiloSessionId: 'kilo_cloudflare',
      },
      context: { workspacePath: '/workspace/cloudflare' },
    },
  };
}

describe('persisted sandbox cleanup routing', () => {
  it('uses the historical DIND namespace for retired metadata without a saved sandbox ID', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getSandbox).mockReturnValue({ destroy } as unknown as SandboxInstance);
    const env = { SandboxDIND: {} } as unknown as Env;
    const legacy = metadata();
    legacy.workspace = { devcontainerRequested: true };
    legacy.identity.sessionId = 'agent_abc123';
    await new CloudflareAgentSandbox(env, legacy).delete('recovery');
    expect(getSandbox).toHaveBeenCalledWith(
      env.SandboxDIND,
      'dind-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370'
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([{ sandboxId: 'dind-abcdef' as const }, { devcontainer: true }])(
    'rejects retired wrapper bootstrap before resolving any sandbox: %j',
    async options => {
      const resolveSandbox = vi.fn();
      const legacy = metadata(options);
      const runtime = new CloudflareAgentSandbox({} as Env, legacy, { resolveSandbox });
      const request = ensureRequest();
      request.plan.workspace.metadata = legacy;
      request.plan.workspace.sandboxId = legacy.workspace!.sandboxId!;
      await expect(runtime.ensureWrapper(request)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('Devcontainer support has been retired'),
      });
      expect(resolveSandbox).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['ses-abcdef', 'Sandbox'],
    ['crv-abcdef', 'Sandbox'],
    ['dind-abcdef', 'SandboxDIND'],
    ['istd-abcdef', 'Sandbox'],
  ] as const)(
    'destroys persisted non-contained %s through its routed namespace',
    async (sandboxId, namespace) => {
      const destroy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getSandbox).mockReturnValue({ destroy } as unknown as SandboxInstance);
      const env = { [namespace]: {} } as unknown as Env;
      const runtime = new CloudflareAgentSandbox(env, metadata({ sandboxId }));
      await runtime.delete('recovery');
      expect(getSandbox).toHaveBeenCalledWith(env[namespace], sandboxId);
      expect(destroy).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [undefined, 'ses', 'Sandbox'],
    ['code-review', 'crv', 'Sandbox'],
  ] as const)(
    'keeps legacy %s fallback routing when metadata has no sandbox ID',
    async (billingOrigin, prefix, namespace) => {
      const destroy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getSandbox).mockReturnValue({ destroy } as unknown as SandboxInstance);
      const env = { PER_SESSION_SANDBOX_ORG_IDS: '*', [namespace]: {} } as unknown as Env;
      const legacy = metadata();
      legacy.workspace = undefined;
      legacy.identity.sessionId = 'agent_abc123';
      legacy.identity.billingOrigin = billingOrigin;
      await new CloudflareAgentSandbox(env, legacy).delete('recovery');
      expect(getSandbox).toHaveBeenCalledWith(
        env[namespace],
        `${prefix}-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370`
      );
      expect(destroy).toHaveBeenCalledOnce();
    }
  );
});

describe('CloudflareAgentSandbox', () => {
  it('keeps default billing configuration when the sandbox resolver is injected', async () => {
    const configureBilling = vi.fn().mockResolvedValue(undefined);
    const renewActivityTimeout = vi.fn();
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({ configureBilling, renewActivityTimeout }) as unknown as SandboxInstance,
    });

    await sandbox.keepAlive();

    expect(configureBilling).toHaveBeenCalledOnce();
    expect(renewActivityTimeout).toHaveBeenCalledOnce();
  });

  it('awaits trusted attribution configuration before using an injected sandbox', async () => {
    let finishConfiguration = () => {};
    const configureBilling = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishConfiguration = resolve;
        })
    );
    const renewActivityTimeout = vi.fn();
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ renewActivityTimeout }) as unknown as SandboxInstance,
      configureBilling,
    });

    const keepAlive = sandbox.keepAlive();
    await vi.waitFor(() => expect(configureBilling).toHaveBeenCalledOnce());
    expect(renewActivityTimeout).not.toHaveBeenCalled();
    finishConfiguration();
    await expect(keepAlive).resolves.toBeUndefined();

    expect(configureBilling).toHaveBeenCalledOnce();
    expect(renewActivityTimeout).toHaveBeenCalledOnce();
  });

  it('retries billing configuration on a fresh sandbox and uses the recovered handle', async () => {
    const error = Object.assign(new Error('Durable Object reset'), { retryable: true });
    const failed = {
      configureBilling: vi.fn().mockRejectedValue(error),
      renewActivityTimeout: vi.fn(),
    };
    const recovered = {
      configureBilling: vi.fn().mockResolvedValue(undefined),
      renewActivityTimeout: vi.fn(),
    };
    const resolveSandbox = vi
      .fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(failed)
      .mockReturnValue(recovered);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), { resolveSandbox });

    await sandbox.keepAlive();

    expect(resolveSandbox).toHaveBeenCalledTimes(3);
    expect(failed.configureBilling).toHaveBeenCalledOnce();
    expect(recovered.configureBilling).toHaveBeenCalledWith(
      failed.configureBilling.mock.calls[0][0]
    );
    expect(failed.renewActivityTimeout).not.toHaveBeenCalled();
    expect(recovered.renewActivityTimeout).toHaveBeenCalledOnce();
  });

  it.each([
    { flags: { retryable: true }, attempts: 3 },
    { flags: { retryable: false }, attempts: 1 },
    { flags: { overloaded: true }, attempts: 1 },
  ])(
    'propagates billing configuration failure after $attempts attempts: $flags',
    async ({ flags, attempts }) => {
      const error = Object.assign(new Error('Billing configuration failed'), flags);
      const configureBilling = vi.fn().mockRejectedValue(error);
      const renewActivityTimeout = vi.fn();
      const resolveSandbox = vi.fn(
        () => ({ configureBilling, renewActivityTimeout }) as unknown as SandboxInstance
      );
      const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), { resolveSandbox });

      await expect(sandbox.keepAlive()).rejects.toBe(error);

      expect(configureBilling).toHaveBeenCalledTimes(attempts);
      expect(resolveSandbox).toHaveBeenCalledTimes(attempts + 1);
      expect(renewActivityTimeout).not.toHaveBeenCalled();
    }
  );

  it('starts an ordinary bootstrap wrapper through the adapter', async () => {
    const bootstrapSession = {};
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
          createSession,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(createSession).toHaveBeenCalledWith({
      name: 'agent_cloudflare-bootstrap',
      env: {},
      cwd: '/',
    });
    expect(ensureBootstrapWrapper).toHaveBeenCalledWith(expect.anything(), bootstrapSession, {
      agentSessionId: 'agent_cloudflare',
      userId: 'user_cloudflare',
    });
    ensureBootstrapWrapper.mockRestore();
  });

  it('passes TOOL_CGROUP_* env through without organization gating', async () => {
    const bootstrapSession = {};
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sandbox = new CloudflareAgentSandbox(
      { TOOL_CGROUP_RESERVE_MB: '2048' } as unknown as Env,
      metadata(),
      {
        resolveSandbox: () =>
          ({
            exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
            createSession,
          }) as unknown as SandboxInstance,
      }
    );

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(ensureBootstrapWrapper).toHaveBeenCalledWith(expect.anything(), bootstrapSession, {
      agentSessionId: 'agent_cloudflare',
      userId: 'user_cloudflare',
      toolCgroupEnv: { TOOL_CGROUP_RESERVE_MB: '2048' },
    });
    ensureBootstrapWrapper.mockRestore();
  });

  it('omits toolCgroupEnv when no TOOL_CGROUP_* values are configured', async () => {
    const bootstrapSession = {};
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
          createSession,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(ensureBootstrapWrapper).toHaveBeenCalledWith(expect.anything(), bootstrapSession, {
      agentSessionId: 'agent_cloudflare',
      userId: 'user_cloudflare',
    });
    ensureBootstrapWrapper.mockRestore();
  });

  it('passes kiloServerEnv through when KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS is set', async () => {
    const bootstrapSession = {};
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sandbox = new CloudflareAgentSandbox(
      { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: '120000' } as unknown as Env,
      metadata(),
      {
        resolveSandbox: () =>
          ({
            exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
            createSession,
          }) as unknown as SandboxInstance,
      }
    );

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(ensureBootstrapWrapper).toHaveBeenCalledWith(expect.anything(), bootstrapSession, {
      agentSessionId: 'agent_cloudflare',
      userId: 'user_cloudflare',
      kiloServerEnv: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: '120000' },
    });
    ensureBootstrapWrapper.mockRestore();
  });

  it('activates containment before probing a sandbox with Kilo-only containment', async () => {
    const bootstrapSession = {};
    const setOutboundHandler = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' });
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const configureBilling = vi.fn().mockResolvedValue(undefined);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sessionMetadata = metadata({
      githubRepo: 'Kilo-Org/containment-canary',
      sandboxId: 'usr-shared',
      credentialContainment: { github: false, gitlab: false, kilocode: true },
    });
    const env = {} as Env;
    const sandbox = new CloudflareAgentSandbox(env, sessionMetadata, {
      resolveSandbox: () =>
        ({ setOutboundHandler, exec, createSession }) as unknown as SandboxInstance,
      configureBilling,
    });

    await sandbox.ensureWrapper(
      ensureRequest({ githubRepo: 'Kilo-Org/containment-canary', sandboxId: 'usr-shared' })
    );

    expect(setOutboundHandler).toHaveBeenCalledWith('managedScm');
    expect(configureBilling).toHaveBeenCalledWith(expect.anything(), {
      sandboxId: 'usr-shared',
      subject: { type: 'org', id: 'org_cloudflare' },
      actor: { type: 'user', id: 'user_cloudflare' },
    });
    expect(configureBilling.mock.invocationCallOrder[0]).toBeLessThan(
      setOutboundHandler.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(setOutboundHandler.mock.invocationCallOrder[0]).toBeLessThan(
      exec.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    ensureBootstrapWrapper.mockRestore();
  });

  it('requests paid admission for an organization canary before sandbox work', async () => {
    const ensureBillingAdmission = vi.fn().mockResolvedValue({
      success: false,
      code: 'insufficient_credits',
      message: 'Low balance',
    });
    const sandbox = new CloudflareAgentSandbox(
      {
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org_cloudflare',
      } as Env,
      metadata({ sandboxId: 'usr-shared' }),
      {
        resolveSandbox: () => ({}) as SandboxInstance,
        ensureBillingAdmission,
        isBillingBlocked: vi.fn().mockResolvedValue(false),
      }
    );

    await expect(sandbox.ensureBillingAdmission()).resolves.toMatchObject({
      success: false,
      code: 'insufficient_credits',
    });
    expect(ensureBillingAdmission).toHaveBeenCalledWith(expect.anything(), {
      sandboxId: 'usr-shared',
      subject: { type: 'org', id: 'org_cloudflare' },
      actor: { type: 'user', id: 'user_cloudflare' },
      enforcementRequested: true,
    });
  });

  it('fails closed for a rejected billing block RPC when enforcement is requested', async () => {
    const isBillingBlocked = vi.fn().mockRejectedValue(new Error('RPC unavailable'));
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata({ sandboxId: 'usr-shared' }), {
      resolveSandbox: () => ({ isBillingBlocked }) as unknown as SandboxInstance,
    });

    await expect(sandbox.isBillingBlocked(true)).resolves.toBe(true);
    await expect(sandbox.isBillingBlocked()).resolves.toBe(false);
  });

  it('types ENOSPC during the cold bootstrap probe as sandbox unusable', async () => {
    const createSession = vi.fn();
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          exec: vi.fn().mockResolvedValue({
            exitCode: 1,
            stdout: '',
            stderr: 'ENOSPC: no space left on device',
          }),
          createSession,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).rejects.toBeInstanceOf(
      SandboxCapacityInspectionError
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects cold bootstrap admission before creating a wrapper session', async () => {
    const createSession = vi.fn();
    const ensureBootstrapWrapper = vi.spyOn(WrapperClient, 'ensureBootstrapWrapper');
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '536870912  10485760000\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no sessions' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '536870912  10485760000\n', stderr: '' });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ exec, createSession }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).rejects.toBeInstanceOf(
      WorkspaceCapacityAdmissionRejectedError
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(ensureBootstrapWrapper).not.toHaveBeenCalled();
    ensureBootstrapWrapper.mockRestore();
  });

  it('reclaims stale bootstrap workspaces without inspecting Docker', async () => {
    const bootstrapSession = {};
    const createSession = vi.fn().mockResolvedValue(bootstrapSession);
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '536870912  10485760000\n', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'agent_stale-aaaa\nagent_cloudflare\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '3145728000  10485760000\n', stderr: '' });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          exec,
          listProcesses: vi.fn().mockResolvedValue([]),
          createSession,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(exec.mock.calls.every(call => !call[0].includes('docker'))).toBe(true);
    expect(createSession).toHaveBeenCalled();
    ensureBootstrapWrapper.mockRestore();
  });

  it('passes a leased physical identity into bootstrap startup', async () => {
    const bootstrapSession = {};
    const ensureBootstrapWrapper = vi
      .spyOn(WrapperClient, 'ensureBootstrapWrapper')
      .mockResolvedValueOnce({ client: {} as WrapperClient });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
          createSession: vi.fn().mockResolvedValue(bootstrapSession),
        }) as unknown as SandboxInstance,
    });

    await sandbox.ensureWrapper(ensureRequest({ leased: true }));

    expect(ensureBootstrapWrapper).toHaveBeenCalledWith(expect.anything(), bootstrapSession, {
      agentSessionId: 'agent_cloudflare',
      userId: 'user_cloudflare',
      leasedInstance: { instanceId: 'instance_cloudflare', instanceGeneration: 3 },
    });
    ensureBootstrapWrapper.mockRestore();
  });

  it('gets an existing running wrapper without provisioning compute', async () => {
    const getSession = vi.fn().mockResolvedValue({});
    const createSession = vi.fn();
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockResolvedValue([
            {
              id: 'wrapper-1',
              command: 'kilocode-wrapper WRAPPER_PORT=5000 --agent-session agent_cloudflare',
              status: 'running',
            },
          ]),
          getSession,
          createSession,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.getRunningWrapper()).resolves.toBeInstanceOf(WrapperClient);
    expect(getSession).toHaveBeenCalledWith('agent_cloudflare-bootstrap');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns a terminal client only for a healthy live wrapper', async () => {
    const containerFetch = vi.fn().mockResolvedValue(
      Response.json({
        healthy: true,
        state: 'idle',
        version: WRAPPER_VERSION,
        sessionId: 'kilo-cloudflare',
      })
    );
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockResolvedValue([
            {
              id: 'wrapper-1',
              command: 'kilocode-wrapper WRAPPER_PORT=5000 --agent-session agent_cloudflare',
              status: 'running',
            },
          ]),
          containerFetch,
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.getRunningTerminalClient()).resolves.toMatchObject({ status: 'ready' });
  });

  it('distinguishes an unhealthy live wrapper from an absent terminal wrapper', async () => {
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockResolvedValue([
            {
              id: 'wrapper-1',
              command: 'kilocode-wrapper WRAPPER_PORT=5000 --agent-session agent_cloudflare',
              status: 'running',
            },
          ]),
          containerFetch: vi.fn().mockResolvedValue(
            Response.json({
              healthy: false,
              state: 'idle',
              version: WRAPPER_VERSION,
              sessionId: 'kilo-cloudflare',
            })
          ),
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.getRunningTerminalClient()).resolves.toEqual({ status: 'unhealthy' });
  });

  it('discovers all tagged and legacy physical wrappers for its session', async () => {
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockResolvedValue([
            {
              id: 'wrapper-tagged',
              command:
                'WRAPPER_PORT=5000 kilocode-wrapper --agent-session agent_cloudflare --wrapper-instance-id instance_1 --wrapper-instance-generation 2',
              status: 'running',
            },
            {
              id: 'wrapper-legacy',
              command: 'WRAPPER_PORT=5001 kilocode-wrapper --agent-session agent_cloudflare',
              status: 'running',
            },
          ]),
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.discoverSessionWrappers()).resolves.toEqual({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'wrapper-tagged',
          port: 5000,
          instanceId: 'instance_1',
          instanceGeneration: 2,
        },
        { representation: 'process', id: 'wrapper-legacy', port: 5001 },
      ],
    });
  });

  it('does not report lifecycle absence when physical inspection fails', async () => {
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockRejectedValue(new Error('sandbox unavailable')),
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.discoverSessionWrappers()).resolves.toMatchObject({
      status: 'inspection-failed',
      error: expect.stringContaining('sandbox unavailable'),
    });
  });

  it('does not require Docker discovery for standard sandboxes', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('docker unavailable'));
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({ listProcesses: vi.fn().mockResolvedValue([]), exec }) as unknown as SandboxInstance,
    });

    await expect(sandbox.discoverSessionWrappers()).resolves.toEqual({ status: 'absent' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('requires container discovery for a DIND sandbox even before resolved devcontainer metadata exists', async () => {
    const unresolvedDindMetadata = {
      ...metadata(),
      workspace: { sandboxId: 'dind-unresolved' },
    } satisfies SessionMetadata;
    const sandbox = new CloudflareAgentSandbox({} as Env, unresolvedDindMetadata, {
      resolveSandbox: () =>
        ({
          listProcesses: vi.fn().mockResolvedValue([]),
          exec: vi.fn().mockRejectedValue(new Error('docker inspection unavailable')),
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.discoverSessionWrappers()).resolves.toMatchObject({
      status: 'inspection-failed',
      error: expect.stringContaining('docker inspection unavailable'),
    });
  });

  it('stops remaining session wrappers before confirming an instance target is absent', async () => {
    const stopObservedWrappers = vi.fn().mockResolvedValue(undefined);
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'wrapper-legacy',
          command: 'WRAPPER_PORT=5001 kilocode-wrapper --agent-session agent_cloudflare',
          status: 'running',
        },
      ])
      .mockResolvedValueOnce([]);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ listProcesses }) as unknown as SandboxInstance,
      stopObservedWrappers,
      stopObservationDelaysMs: [0],
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      sandbox.stopWrappers({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance_gone', instanceGeneration: 1 },
        },
        attemptId: 'attempt_residual',
        reason: 'session-delete',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(stopObservedWrappers).toHaveBeenCalledWith(expect.anything(), 'agent_cloudflare', [
      { representation: 'process', id: 'wrapper-legacy', port: 5001 },
    ]);
  });

  it('force stops a targeted wrapper that remains after graceful termination and confirms absence', async () => {
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'wrapper-target',
          command:
            'WRAPPER_PORT=5000 kilocode-wrapper --agent-session agent_cloudflare --wrapper-instance-id instance_1 --wrapper-instance-generation 2',
          status: 'running',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wrapper-target',
          command:
            'WRAPPER_PORT=5000 kilocode-wrapper --agent-session agent_cloudflare --wrapper-instance-id instance_1 --wrapper-instance-generation 2',
          status: 'running',
        },
      ])
      .mockResolvedValueOnce([]);
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ listProcesses, exec }) as unknown as SandboxInstance,
      sleep: vi.fn().mockResolvedValue(undefined),
      stopObservationDelaysMs: [0],
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'instance', instance: { instanceId: 'instance_1', instanceGeneration: 2 } },
        attemptId: 'attempt_1',
        reason: 'readiness-failed',
      })
    ).resolves.toEqual({ status: 'absent', stoppedInstanceIds: ['instance_1'] });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('pkill -f --'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('pkill -9 -f --'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('--agent-session agent_cloudflare'));
  });

  it('returns still-present when targeted forceful cleanup remains observable', async () => {
    const observedProcess = {
      id: 'wrapper-target',
      command:
        'WRAPPER_PORT=5000 kilocode-wrapper --agent-session agent_cloudflare --wrapper-instance-id instance_1 --wrapper-instance-generation 2',
      status: 'running',
    };
    const listProcesses = vi.fn().mockResolvedValue([observedProcess]);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses,
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
        }) as unknown as SandboxInstance,
      sleep: vi.fn().mockResolvedValue(undefined),
      stopObservationDelaysMs: [0],
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'instance', instance: { instanceId: 'instance_1', instanceGeneration: 2 } },
        attemptId: 'attempt_remaining',
        reason: 'readiness-failed',
      })
    ).resolves.toMatchObject({ status: 'still-present' });
  });

  it('confirms absence for an idle-timeout stop without waking a stopped container', async () => {
    const listProcesses = vi.fn().mockResolvedValue([]);
    const isContainerRunning = vi.fn().mockResolvedValue(false);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ listProcesses, isContainerRunning }) as unknown as SandboxInstance,
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt_idle',
        reason: 'idle-timeout',
      })
    ).resolves.toEqual({ status: 'absent' });
    // The whole point: no container fetch, so a sleeping container stays asleep.
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it('still inspects an idle-timeout stop while the container is running', async () => {
    const listProcesses = vi.fn().mockResolvedValue([]);
    const isContainerRunning = vi.fn().mockResolvedValue(true);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ listProcesses, isContainerRunning }) as unknown as SandboxInstance,
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt_idle_running',
        reason: 'idle-timeout',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(listProcesses).toHaveBeenCalled();
  });

  it('does not wake a confirmed stopped container for session deletion cleanup', async () => {
    const listProcesses = vi.fn().mockResolvedValue([]);
    const isContainerRunning = vi.fn().mockResolvedValue(false);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ listProcesses, isContainerRunning }) as unknown as SandboxInstance,
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt_delete',
        reason: 'session-delete',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(isContainerRunning).toHaveBeenCalledOnce();
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it('falls back to inspection when the sandbox cannot report container state', async () => {
    const listProcesses = vi.fn().mockResolvedValue([]);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      // No isContainerRunning: an unknown state must not be treated as "stopped".
      resolveSandbox: () => ({ listProcesses }) as unknown as SandboxInstance,
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt_unknown',
        reason: 'idle-timeout',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(listProcesses).toHaveBeenCalled();
  });

  it('returns inspection-failed from stop when post-stop inspection cannot prove absence', async () => {
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'wrapper-target',
          command:
            'WRAPPER_PORT=5000 kilocode-wrapper --agent-session agent_cloudflare --wrapper-instance-id instance_1 --wrapper-instance-generation 2',
          status: 'running',
        },
      ])
      .mockRejectedValueOnce(new Error('cannot re-observe'));
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          listProcesses,
          exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        }) as unknown as SandboxInstance,
      sleep: vi.fn().mockResolvedValue(undefined),
      stopObservationDelaysMs: [0],
    });

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt_2',
        reason: 'unexpected-wrapper',
      })
    ).resolves.toMatchObject({ status: 'inspection-failed' });
  });

  it('renews and health-checks the existing runtime', async () => {
    const renewActivityTimeout = vi.fn().mockResolvedValue(undefined);
    const listProcesses = vi.fn().mockResolvedValue([]);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ renewActivityTimeout, listProcesses }) as unknown as SandboxInstance,
    });

    await sandbox.keepAlive();
    await sandbox.probeHealth();

    expect(renewActivityTimeout).toHaveBeenCalledOnce();
    expect(listProcesses).toHaveBeenCalledOnce();
  });

  it('deletes session resources without destroying a shared sandbox', async () => {
    const destroy = vi.fn();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () =>
        ({
          getSession: vi.fn().mockResolvedValue({
            exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
          }),
          deleteSession,
          destroy,
        }) as unknown as SandboxInstance,
    });

    await sandbox.delete('explicit');

    expect(deleteSession).toHaveBeenCalledWith('agent_cloudflare');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('maps infrastructure recovery to destructive Cloudflare sandbox replacement', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata(), {
      resolveSandbox: () => ({ destroy }) as unknown as SandboxInstance,
    });

    await sandbox.delete('recovery');

    expect(destroy).toHaveBeenCalledOnce();
  });
});
