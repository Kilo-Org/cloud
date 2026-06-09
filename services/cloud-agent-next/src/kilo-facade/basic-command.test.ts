import type { SessionCommandResponse } from '@kilocode/sdk/v2';
import { describe, expect, it } from 'vitest';
import { buildSyntheticCommandResponse, parseBasicKiloCommand } from './basic-command.js';

const messageId = 'msg_00000000000000000000000001';

describe('parseBasicKiloCommand', () => {
  it('projects a native command body into a durable command request', () => {
    expect(
      parseBasicKiloCommand({
        messageID: messageId,
        command: 'review/security',
        arguments: '  --strict  ',
        agent: 'code',
        model: 'kilo/anthropic/claude-sonnet-4',
        variant: 'high',
        snapshotInitialization: 'wait',
        parts: [],
      })
    ).toEqual({
      success: true,
      command: {
        messageId,
        command: 'review/security',
        arguments: '  --strict  ',
        agent: {
          mode: 'code',
          model: 'anthropic/claude-sonnet-4',
          variant: 'high',
        },
        snapshotInitialization: 'wait',
      },
    });
  });

  it('accepts the minimal command body without resolving durable defaults', () => {
    expect(parseBasicKiloCommand({ command: 'init', arguments: '' })).toEqual({
      success: true,
      command: { messageId: undefined, command: 'init', arguments: '' },
    });
  });

  it('reports non-empty file parts as explicitly unsupported', () => {
    expect(
      parseBasicKiloCommand({
        command: 'init',
        arguments: '',
        parts: [{ type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt' }],
      })
    ).toEqual({ success: false, reason: 'parts-unsupported' });
  });

  it.each([
    [{ command: 'init' }],
    [{ command: '', arguments: '' }],
    [{ command: ' '.repeat(2), arguments: '' }],
    [{ command: 'x'.repeat(101), arguments: '' }],
    [{ command: 'init', arguments: 'x'.repeat(100_001) }],
    [{ command: 'init', arguments: '', messageID: 'msg_invalid' }],
    [{ command: 'init', arguments: '', agent: 'Build' }],
    [{ command: 'init', arguments: '', model: 'anthropic/claude' }],
    [{ command: 'init', arguments: '', model: 'kilo/' }],
    [{ command: 'init', arguments: '', snapshotInitialization: 'continue' }],
    [{ command: 'init', arguments: '', parts: 'not-an-array' }],
    [{ command: 'init', arguments: '', unknown: true }],
  ])('rejects unsupported native command bodies', body => {
    expect(parseBasicKiloCommand(body)).toEqual({ success: false, reason: 'invalid' });
  });
});

describe('buildSyntheticCommandResponse', () => {
  it('builds an SDK-valid acknowledgement without claiming command completion', () => {
    const response = buildSyntheticCommandResponse({
      now: 1_750_000_000_000,
      assistantMessageId: 'msg_00000000000000000000000002',
      admittedMessageId: messageId,
      kiloSessionId: 'ses_12345678901234567890123456',
      publicDirectory: '/cloud-agent/sessions/ses_12345678901234567890123456',
      requestedAgent: 'code',
      requestedModel: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
    const sdkResponse: SessionCommandResponse = response;

    expect(sdkResponse).toEqual({
      info: {
        id: 'msg_00000000000000000000000002',
        sessionID: 'ses_12345678901234567890123456',
        role: 'assistant',
        time: { created: 1_750_000_000_000 },
        parentID: messageId,
        modelID: 'anthropic/claude-sonnet-4',
        providerID: 'kilo',
        mode: 'code',
        agent: 'code',
        path: {
          cwd: '/cloud-agent/sessions/ses_12345678901234567890123456',
          root: '/cloud-agent/sessions/ses_12345678901234567890123456',
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        variant: 'high',
      },
      parts: [],
    });
  });
});
