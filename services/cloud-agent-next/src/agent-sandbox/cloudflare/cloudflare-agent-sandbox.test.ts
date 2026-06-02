import { describe, expect, it, vi } from 'vitest';
import type { Env, SandboxInstance } from '../../types.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { WrapperClient } from '../../kilo/wrapper-client.js';
import { WRAPPER_VERSION } from '../../shared/wrapper-version.js';
import type { EnsureWrapperRequest } from '../protocol.js';
import { CloudflareAgentSandbox } from './cloudflare-agent-sandbox.js';
import {
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
} from '../../workspace-errors.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

function metadata(options?: { devcontainer?: boolean }): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_cloudflare', userId: 'user_cloudflare', orgId: 'org_cloudflare' },
    auth: {},
    workspace: {
      sandboxId: options?.devcontainer ? 'dind-abcdef' : 'ses-abcdef',
    },
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
}): EnsureWrapperRequest {
  const sandboxId = options?.devcontainer ? 'dind-abcdef' : 'ses-abcdef';
  const sessionMetadata = metadata(options);
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

describe('CloudflareAgentSandbox', () => {
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

  it('keeps unresolved DIND bootstrap cleanup fail-closed', async () => {
    const unresolvedDindMetadata = {
      ...metadata(),
      workspace: { sandboxId: 'dind-unresolved' },
    } satisfies SessionMetadata;
    const request = ensureRequest();
    request.plan.workspace = { sandboxId: 'dind-unresolved', metadata: unresolvedDindMetadata };
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '536870912  10485760000\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'agent_stale-aaaa\n', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/run/user/1000/docker.sock',
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('docker inspection unavailable'))
      .mockResolvedValueOnce({ exitCode: 0, stdout: '536870912  10485760000\n', stderr: '' });
    const sandbox = new CloudflareAgentSandbox({} as Env, unresolvedDindMetadata, {
      resolveSandbox: () =>
        ({
          exec,
          listProcesses: vi.fn().mockResolvedValue([]),
          createSession: vi.fn(),
        }) as unknown as SandboxInstance,
    });

    await expect(sandbox.ensureWrapper(request)).rejects.toBeInstanceOf(
      WorkspaceCapacityAdmissionRejectedError
    );
    expect(exec.mock.calls[4][0]).toContain('docker ps');
    expect(exec.mock.calls.every(call => !call[0].includes('stat'))).toBe(true);
    expect(exec.mock.calls.every(call => !call[0].includes('rm -rf'))).toBe(true);
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

  it('does not start a devcontainer wrapper after cold workspace admission is rejected', async () => {
    const rejection = new WorkspaceCapacityAdmissionRejectedError({
      availableMB: 512,
      thresholdMB: 2048,
      cleaned: 0,
      skipped: 1,
    });
    const prepareWorkspace = vi.fn().mockRejectedValue(rejection);
    const ensureWrapper = vi.spyOn(WrapperClient, 'ensureWrapper');
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata({ devcontainer: true }), {
      resolveSandbox: () => ({}) as SandboxInstance,
      sessionService: { prepareWorkspace } as never,
    });

    await expect(sandbox.ensureWrapper(ensureRequest({ devcontainer: true }))).rejects.toBe(
      rejection
    );
    expect(ensureWrapper).not.toHaveBeenCalled();
    ensureWrapper.mockRestore();
  });

  it('prepares and starts a devcontainer wrapper through the adapter', async () => {
    const devcontainer = {
      containerId: 'container-dev',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/cloudflare',
      agentSessionId: 'agent_cloudflare',
      overrideConfigPath: '/tmp/devcontainer.json',
      teardown: vi.fn(),
    };
    const request = ensureRequest({ devcontainer: true, leased: true });
    const prepareWorkspace = vi.fn().mockResolvedValue({
      context: { workspacePath: '/workspace/cloudflare' },
      ready: {
        ...request.prepared.ready,
        devcontainer: {
          workspacePath: '/workspace/cloudflare',
          innerWorkspaceFolder: '/workspaces/repo',
          wrapperPort: 4173,
          configPath: '.devcontainer/devcontainer.json',
        },
      },
      runtimeEnv: {},
      session: {},
      devcontainer,
    });
    const ensureWrapper = vi.spyOn(WrapperClient, 'ensureWrapper').mockResolvedValueOnce({
      client: {} as WrapperClient,
      sessionId: 'kilo_cloudflare',
    });
    const sandbox = new CloudflareAgentSandbox({} as Env, metadata({ devcontainer: true }), {
      resolveSandbox: () => ({}) as SandboxInstance,
      sessionService: { prepareWorkspace } as never,
    });

    await expect(sandbox.ensureWrapper(request)).resolves.toMatchObject({
      status: 'session-ready',
      kiloSessionId: 'kilo_cloudflare',
    });
    expect(ensureWrapper).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fixedPort: 4173,
        devcontainer,
        leasedInstance: { instanceId: 'instance_cloudflare', instanceGeneration: 3 },
      })
    );
    ensureWrapper.mockRestore();
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
