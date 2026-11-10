import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  buildControlPlaneCreateInput,
  buildControlPlaneMessagePayload,
  buildControlPlaneRegisterInput,
  buildControlPlanePromptPayload,
} from './control-plane-session-input.js';
import { buildControlPlaneSessionRegistration } from '../control-plane/session/registration.js';

const FULL_MODEL = 'kilo/fake-deterministic';
const MODERN_KILO_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln';

describe('buildControlPlanePromptPayload', () => {
  it('preserves a repository agent slug without runtimeAgents', () => {
    const payload = buildControlPlanePromptPayload({
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      turn: { type: 'prompt', prompt: 'Use foreman' },
      attachments: [],
      agent: { mode: 'foreman', model: FULL_MODEL },
    });
    expect(payload.agent).toEqual({ mode: 'foreman', model: 'fake-deterministic' });
  });

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

describe('buildControlPlaneMessagePayload variant inheritance', () => {
  const storedMetadata = {
    agent: { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4', variant: 'high' },
  } as SessionMetadata;

  function buildCommandPayload(agentOverride?: {
    mode?: string;
    model?: string;
    variant?: string;
  }) {
    return buildControlPlaneMessagePayload({
      env: {} as Env,
      userId: 'user-1',
      sessionId: 'workspace_12345678-1234-4234-8234-123456789012' as never,
      metadata: storedMetadata,
      turn: { type: 'command', command: 'compact', arguments: '' },
      ...(agentOverride ? { agentOverride } : {}),
    });
  }

  it('does not pair a new model with the stored model variant', async () => {
    const payload = await buildCommandPayload({ model: 'kilo/anthropic/claude-opus-4' });
    expect(payload.agent).toEqual({ mode: 'code', model: 'anthropic/claude-opus-4' });
  });

  it('inherits the stored variant when the override keeps the stored model', async () => {
    const payload = await buildCommandPayload({ model: 'anthropic/claude-sonnet-4' });
    expect(payload.agent).toEqual({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
  });

  it('inherits the stored model and variant when the model is not overridden', async () => {
    const payload = await buildCommandPayload({ mode: 'code' });
    expect(payload.agent).toEqual({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
  });

  it('uses an explicit variant alongside a model override', async () => {
    const payload = await buildCommandPayload({
      model: 'kilo/anthropic/claude-opus-4',
      variant: 'low',
    });
    expect(payload.agent).toEqual({
      mode: 'code',
      model: 'anthropic/claude-opus-4',
      variant: 'low',
    });
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
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: MODERN_KILO_TOKEN },
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

  it.each(
    [
      { egressMode: undefined, egressAllowlist: undefined },
      { egressMode: 'unrestricted' as const, egressAllowlist: undefined },
      { egressMode: 'allowlist' as const, egressAllowlist: undefined },
      { egressMode: 'allowlist' as const, egressAllowlist: [] },
      { egressMode: 'allowlist' as const, egressAllowlist: ['Z.Example.COM.', 'example.com'] },
    ].flatMap(policy =>
      [undefined, false, true].map(egressAudit => ({
        ...policy,
        egressAudit,
      }))
    )
  )(
    'persists and selects the same policy for start and registration: %j',
    async ({ egressMode, egressAllowlist, egressAudit }) => {
      const command = {
        identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: MODERN_KILO_TOKEN },
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
          egressAudit,
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
        expect(input.metadata.workspace?.egressAudit).toBe(egressAudit);
        expect(input.sandboxSelection.egressAudit).toBe(egressAudit);
        expect(
          buildControlPlaneSessionRegistration(input.metadata, input.sandboxSelection)
            .sandboxSelection?.egressAudit
        ).toBe(egressAudit);
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
            auth: {
              kiloSessionId: 'ses_12345678901234567890123456',
              kilocodeToken: MODERN_KILO_TOKEN,
            },
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

  it('carries the isolated kind into the pin and its billing input', async () => {
    const sandboxKind = 'isolated';
    const sandboxId = `sbx-${'a'.repeat(48)}` as const;
    const input = await buildControlPlaneCreateInput({
      command: {
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
        },
        auth: {
          kiloSessionId: 'ses_12345678901234567890123456',
          kilocodeToken: MODERN_KILO_TOKEN,
        },
        message: {
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          turn: { type: 'prompt', prompt: 'hi' },
        },
        agent: { mode: 'code', model: FULL_MODEL },
        workspace: { sandboxId, sandboxProvider: 'cloudflare', sandboxKind: 'isolated' },
      },
      env: {} as Env,
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });

    expect(input.metadata.workspace?.sandboxKind).toBe(sandboxKind);
    expect(input.sandboxSelection.sandboxKind).toBe(sandboxKind);
    expect(input.sandboxSelection.billing).toMatchObject({ sandboxId, sandboxKind });
    expect(input.sandboxSelection.billing?.sessionId).toBe(
      'workspace_12345678-1234-1234-1234-123456789abc'
    );
    // The Session DO accepts the Worker's selection as built.
    expect(
      buildControlPlaneSessionRegistration(input.metadata, input.sandboxSelection).sandboxSelection
        ?.sandboxKind
    ).toBe(sandboxKind);
  });

  it('rejects a retired shared kind', async () => {
    const sandboxId = `sbx-${'a'.repeat(48)}` as const;
    await expect(
      buildControlPlaneCreateInput({
        command: {
          identity: {
            sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
            userId: 'usr_1',
          },
          auth: {
            kiloSessionId: 'ses_12345678901234567890123456',
            kilocodeToken: MODERN_KILO_TOKEN,
          },
          message: {
            initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            turn: { type: 'prompt', prompt: 'hi' },
          },
          agent: { mode: 'code', model: FULL_MODEL },
          workspace: { sandboxId, sandboxProvider: 'cloudflare', sandboxKind: 'shared' },
        },
        env: {} as Env,
        attachments: [],
        agent: { mode: 'code', model: FULL_MODEL },
      })
    ).rejects.toThrow('shared sandboxes are retired');
  });

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
          auth: {
            kiloSessionId: 'ses_12345678901234567890123456',
            kilocodeToken: MODERN_KILO_TOKEN,
          },
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

  it('pins code review on Cloudflare Containers to the code-review instance size', async () => {
    const input = await buildControlPlaneCreateInput({
      command: {
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
        },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: MODERN_KILO_TOKEN },
        message: {
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          turn: { type: 'prompt', prompt: 'hi' },
        },
        agent: { mode: 'code', model: FULL_MODEL },
        workspace: {
          sandboxId: 'sbx-0123456789abcdef0123456789abcdef0123456789abcdef',
          sandboxProvider: 'cloudflare-containers',
          sandboxKind: 'code-review',
        },
      },
      env: {} as Env,
      attachments: [],
      agent: { mode: 'code', model: FULL_MODEL },
    });
    expect(input.sandboxSelection.configuration).toEqual({
      provider: 'cloudflare-containers',
      instance: 'code-review',
    });
  });

  it('keeps the full model in stored metadata while dispatching the stripped id', async () => {
    const input = await buildControlPlaneCreateInput({
      command: {
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'usr_1',
        },
        auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: MODERN_KILO_TOKEN },
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
