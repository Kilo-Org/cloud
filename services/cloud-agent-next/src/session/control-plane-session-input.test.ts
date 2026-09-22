import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import {
  buildControlPlaneCreateInput,
  buildControlPlaneRegisterInput,
  buildControlPlanePromptPayload,
} from './control-plane-session-input.js';
import { buildControlPlaneSessionRegistration } from '../control-plane/session/registration.js';

const FULL_MODEL = 'kilo/fake-deterministic';

describe('buildControlPlanePromptPayload', () => {
  it('strips the kilo provider prefix from the wrapper-facing model', () => {
    const payload = buildControlPlanePromptPayload({
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      turn: { type: 'prompt', prompt: 'hi' },
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });
    expect(payload.agent.model).toBe('fake-deterministic');
  });

  it('leaves a bare model id unchanged', () => {
    const payload = buildControlPlanePromptPayload({
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      turn: { type: 'prompt', prompt: 'hi' },
      attachments: [],
      agent: { mode: 'code', model: 'claude-sonnet-4' },
    });
    expect(payload.agent.model).toBe('claude-sonnet-4');
  });

  it('strips the prefix for a command turn, matching legacy dispatch', () => {
    const payload = buildControlPlanePromptPayload({
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      turn: { type: 'command', command: 'compact', arguments: '' },
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });
    expect(payload.agent.model).toBe('fake-deterministic');
  });
});

describe('buildControlPlaneCreateInput', () => {
  it.each([
    { organizationId: '11111111-1111-4111-8111-111111111111' },
    { userId: 'oauth/google/personal-owner' },
  ])('pins the customer credential without Kilo compute billing for %j', async owner => {
    const source = {
      kind: 'byoc' as const,
      ...owner,
      credentialId: '22222222-2222-4222-8222-222222222222',
    };
    const input = await buildControlPlaneCreateInput({
      command: {
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
          orgId: source.organizationId,
        },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
        message: {
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          turn: { type: 'prompt', prompt: 'hi' },
        },
        agent: { mode: 'code', model: FULL_MODEL },
        workspace: {
          sandboxId: 'ses-0123456789abcdef',
          sandboxProvider: 'vercel',
          sandboxProviderBinding: { kind: 'vercel', source },
        },
      },
      env: { CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true' } as Env,
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });
    expect(input.sandboxSelection).toEqual({
      provider: 'vercel',
      configuration: { provider: 'vercel', resources: { vcpus: 2, memory: 4096 } },
      byoc: { ...owner, credentialId: source.credentialId },
    });
  });
  it.each([
    { egressMode: undefined, egressAllowlist: undefined },
    { egressMode: 'unrestricted' as const, egressAllowlist: undefined },
    { egressMode: 'allowlist' as const, egressAllowlist: undefined },
    { egressMode: 'allowlist' as const, egressAllowlist: [] },
    { egressMode: 'allowlist' as const, egressAllowlist: ['Z.Example.COM.', 'example.com'] },
  ])(
    'persists and selects the same policy for start and registration: %j',
    async ({ egressMode, egressAllowlist }) => {
      const command = {
        identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
        message: {
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          turn: { type: 'prompt' as const, prompt: 'hi' },
        },
        agent: { mode: 'code', model: FULL_MODEL },
        workspace: {
          sandboxId: 'ses-0123456789abcdef' as const,
          sandboxProvider: 'cloudflare-containers' as const,
          egressMode,
          egressAllowlist,
        },
      };
      const created = await buildControlPlaneCreateInput({
        command,
        env: {} as Env,
        attachments: [],
        agent: command.agent,
      });
      const registered = await buildControlPlaneRegisterInput({ command, env: {} as Env });
      const expected =
        egressAllowlist === undefined
          ? undefined
          : egressAllowlist.length === 0
            ? []
            : ['example.com', 'z.example.com'];
      for (const input of [created, registered]) {
        expect(input.metadata.workspace?.egressMode).toBe(egressMode);
        expect(input.sandboxSelection.egressMode).toBe(egressMode);
        expect(input.metadata.workspace?.egressAllowlist).toEqual(expected);
        expect(input.sandboxSelection.egressAllowlist).toEqual(expected);
        expect(
          buildControlPlaneSessionRegistration(input.metadata, input.sandboxSelection)
            .sandboxSelection?.egressAllowlist
        ).toEqual(expected);
      }
    }
  );

  it.each([
    [undefined, { vcpus: 2, memory: 4096 }, 'SandboxVercelSmall'],
    ['vercel-large', { vcpus: 4, memory: 8192 }, 'SandboxVercelLarge'],
  ] as const)(
    'rejects retired platform Vercel selection %s',
    async (allocation, _resources, _className) => {
      await expect(
        buildControlPlaneCreateInput({
          command: {
            identity: {
              sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
              userId: 'usr_1',
            },
            auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
            message: {
              initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
              turn: { type: 'prompt', prompt: 'hi' },
            },
            agent: { mode: 'code', model: FULL_MODEL },
            workspace: {
              sandboxId: 'ses-0123456789abcdef',
              sandboxProvider: 'vercel',
              ...(allocation === undefined ? {} : { sandboxAllocation: allocation }),
            },
          },
          env: {} as Env,
          attachments: [],
          agent: { mode: 'code', model: FULL_MODEL },
        })
      ).rejects.toThrow('Kilo-paid Vercel compute is retired');
    }
  );

  it.each([
    ['isolated', 'workspace_12345678-1234-1234-1234-123456789abc'],
    ['shared', undefined],
  ] as const)(
    'carries the %s kind into the pin and its billing input',
    async (sandboxKind, billedSessionId) => {
      const sandboxId = `sbx-${'a'.repeat(48)}` as const;
      const input = await buildControlPlaneCreateInput({
        command: {
          identity: {
            sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
            userId: 'usr_1',
          },
          auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
          message: {
            initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            turn: { type: 'prompt', prompt: 'hi' },
          },
          agent: { mode: 'code', model: FULL_MODEL },
          workspace: { sandboxId, sandboxProvider: 'cloudflare', sandboxKind },
        },
        env: {} as Env,
        attachments: [],
        agent: { mode: 'code', model: FULL_MODEL },
      });

      expect(input.metadata.workspace?.sandboxKind).toBe(sandboxKind);
      expect(input.sandboxSelection.sandboxKind).toBe(sandboxKind);
      expect(input.sandboxSelection.billing).toMatchObject({ sandboxId, sandboxKind });
      expect(input.sandboxSelection.billing?.sessionId).toBe(billedSessionId);
      // The Session DO accepts the Worker's selection as built.
      expect(
        buildControlPlaneSessionRegistration(input.metadata, input.sandboxSelection)
          .sandboxSelection?.sandboxKind
      ).toBe(sandboxKind);
    }
  );

  it.each([
    ['cloudflare-containers-standard-3', 'standard-3'],
    ['cloudflare-containers-standard-4', 'standard-4'],
  ] as const)(
    'pins %s selection to its Cloudflare container instance',
    async (allocation, instance) => {
      const input = await buildControlPlaneCreateInput({
        command: {
          identity: {
            sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
            userId: 'usr_1',
          },
          auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
          message: {
            initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            turn: { type: 'prompt', prompt: 'hi' },
          },
          agent: { mode: 'code', model: FULL_MODEL },
          workspace: {
            sandboxId: 'ses-0123456789abcdef',
            sandboxProvider: 'cloudflare-containers',
            sandboxAllocation: allocation,
          },
        },
        env: {} as Env,
        attachments: [],
        agent: { mode: 'code', model: FULL_MODEL },
      });
      expect(input.sandboxSelection.configuration).toEqual({
        provider: 'cloudflare-containers',
        instance,
      });
    }
  );

  it('keeps the full model in stored metadata while dispatching the stripped id', async () => {
    const input = await buildControlPlaneCreateInput({
      command: {
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
        },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: 'token' },
        message: {
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          turn: { type: 'prompt', prompt: 'hi' },
        },
        agent: { mode: 'code', model: FULL_MODEL },
        workspace: { sandboxId: 'ses-0123456789abcdef', sandboxProvider: 'cloudflare' },
      },
      env: {} as Env,
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });

    expect(input.metadata.agent?.model).toBe(FULL_MODEL);
    expect(input.message.agent.model).toBe('fake-deterministic');
  });
});
