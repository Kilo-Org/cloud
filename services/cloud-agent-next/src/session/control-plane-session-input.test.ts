import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import { vercelBillingIdentity } from '../container-usage-context.js';
import {
  buildControlPlaneCreateInput,
  buildControlPlanePromptPayload,
} from './control-plane-session-input.js';

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
    [undefined, { vcpus: 2, memory: 4096 }, 'SandboxVercelSmall'],
    ['vercel-large', { vcpus: 4, memory: 8192 }, 'SandboxVercelLarge'],
  ] as const)(
    'pins %s Vercel selection to a billable size',
    async (allocation, resources, className) => {
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
            sandboxProvider: 'vercel',
            ...(allocation === undefined ? {} : { sandboxAllocation: allocation }),
          },
        },
        env: {} as Env,
        attachments: [],
        agent: { mode: 'code', model: FULL_MODEL },
      });
      expect(input.sandboxSelection.configuration).toEqual({ provider: 'vercel', resources });
      expect(vercelBillingIdentity(resources).className).toBe(className);
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
