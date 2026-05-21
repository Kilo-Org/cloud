import { describe, expect, it } from 'vitest';
import {
  ExecutionResponse,
  GetSessionOutput,
  InitiateFromPreparedSessionInput,
  LegacyExecutionResponse,
  SendMessageInput,
  SendMessageV2Input,
  StartSessionOutput,
  StartSessionInput,
} from './schemas.js';

const validMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const validSessionId = 'agent_12345678-1234-1234-1234-123456789012';
const validImages = {
  path: '123e4567-e89b-12d3-a456-426614174000',
  files: ['123e4567-e89b-12d3-a456-426614174001.png'],
};
const basePromptInput = {
  prompt: 'continue',
  mode: 'code' as const,
  model: 'claude-sonnet-4-5-20250929',
  variant: 'thinking',
};
const baseSendMessageInput = {
  cloudAgentSessionId: validSessionId,
  ...basePromptInput,
};

const baseStartInput = {
  message: { prompt: 'continue' },
  agent: {
    mode: 'code' as const,
    model: 'claude-sonnet-4-5-20250929',
    variant: 'thinking',
  },
  repository: { type: 'github' as const, repo: 'acme/repo' },
};

describe('grouped unified session input contracts', () => {
  it('preserves the full grouped start payload shape', () => {
    const input = {
      message: {
        prompt: 'Create the first turn',
        images: validImages,
        id: validMessageId,
      },
      agent: {
        mode: 'code',
        model: 'anthropic/claude-sonnet-4-20250514',
        variant: 'thinking',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
        gateThreshold: 'warning',
      },
      repository: {
        type: 'git',
        url: 'https://git.example.com/acme/repo.git',
        token: 'git-token',
        branch: 'feature/contracts',
      },
      profile: {
        id: '123e4567-e89b-12d3-a456-426614174010',
        overrides: {
          envVars: { API_ENDPOINT: 'https://api.example.com' },
          setupCommands: ['pnpm install'],
          appendSystemPrompt: 'Respect repository guidelines.',
        },
      },
      options: {
        kilocodeOrganizationId: '123e4567-e89b-12d3-a456-426614174011',
        createdOnPlatform: 'cloud-agent-web',
      },
    };

    expect(StartSessionInput.parse(input)).toEqual(input);
  });

  it('rejects callback targets on public grouped start options', () => {
    const result = StartSessionInput.safeParse({
      ...baseStartInput,
      options: {
        callbackTarget: {
          url: 'https://worker.example.com/callback',
          headers: { 'X-Contract': 'phase-0' },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('preserves the grouped send payload shape', () => {
    const input = {
      cloudAgentSessionId: validSessionId,
      message: {
        prompt: 'Continue with the queued turn',
        images: validImages,
        id: null,
      },
      agent: {
        mode: 'code',
        model: 'anthropic/claude-sonnet-4-20250514',
        variant: 'thinking',
      },
      finalization: {
        autoCommit: false,
        condenseOnComplete: true,
      },
    };

    expect(SendMessageInput.parse(input)).toEqual(input);
  });
});

describe('sendMessageV2 input compatibility', () => {
  it('normalizes nested prompt payloads from web callers', () => {
    const result = SendMessageV2Input.safeParse({
      cloudAgentSessionId: validSessionId,
      messageId: validMessageId,
      payload: { type: 'prompt', ...basePromptInput },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual({
      cloudAgentSessionId: validSessionId,
      messageId: validMessageId,
      ...basePromptInput,
    });
  });

  it('accepts nested command payloads emitted by CloudChatPage', () => {
    const result = SendMessageV2Input.safeParse({
      cloudAgentSessionId: validSessionId,
      payload: {
        type: 'command',
        command: 'compact',
        arguments: '--aggressive',
      },
      images: validImages,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual({
      cloudAgentSessionId: validSessionId,
      payload: {
        type: 'command',
        command: 'compact',
        arguments: '--aggressive',
      },
      images: validImages,
    });
  });
});

describe('message ID schema validation', () => {
  it('accepts canonical message IDs on public schemas', () => {
    expect(
      SendMessageV2Input.safeParse({ ...baseSendMessageInput, messageId: validMessageId }).success
    ).toBe(true);
    expect(SendMessageV2Input.safeParse({ ...baseSendMessageInput, messageId: null }).success).toBe(
      true
    );
    expect(
      InitiateFromPreparedSessionInput.safeParse({
        cloudAgentSessionId: validSessionId,
      }).success
    ).toBe(true);
    expect(
      GetSessionOutput.safeParse({
        sessionId: validSessionId,
        userId: 'user_test',
        execution: null,
        initialMessageId: validMessageId,
        timestamp: Date.now(),
        version: 1,
      }).success
    ).toBe(true);
    expect(
      ExecutionResponse.safeParse({
        cloudAgentSessionId: validSessionId,
        status: 'started',
        streamUrl: 'https://example.com/stream',
        messageId: validMessageId,
        delivery: 'sent',
      }).success
    ).toBe(true);
    expect(
      StartSessionInput.safeParse({
        ...baseStartInput,
        message: { ...baseStartInput.message, id: validMessageId },
      }).success
    ).toBe(true);
  });

  it('rejects non-canonical message IDs on public schemas', () => {
    const invalidMessageIds = [
      'msg_018F1e2d3c4bAbCdEfGhIjKlMn',
      'msg_018f1e2d3c4bAbCdEfGhIjKlM-',
      'msg_018f1e2d3c4bAbCdEfGhIjKlM',
    ];

    for (const messageId of invalidMessageIds) {
      expect(SendMessageV2Input.safeParse({ ...baseSendMessageInput, messageId }).success).toBe(
        false
      );
      expect(
        InitiateFromPreparedSessionInput.safeParse({
          cloudAgentSessionId: validSessionId,
          messageId,
        }).success
      ).toBe(false);
      expect(
        GetSessionOutput.safeParse({
          sessionId: validSessionId,
          userId: 'user_test',
          execution: null,
          initialMessageId: messageId,
          timestamp: Date.now(),
          version: 1,
        }).success
      ).toBe(false);
      expect(
        ExecutionResponse.safeParse({
          cloudAgentSessionId: validSessionId,
          status: 'started',
          streamUrl: 'https://example.com/stream',
          messageId,
          delivery: 'sent',
        }).success
      ).toBe(false);
      expect(
        StartSessionInput.safeParse({
          ...baseStartInput,
          message: { ...baseStartInput.message, id: messageId },
        }).success
      ).toBe(false);
    }
  });

  it('rejects messageId on initiateFromKilocodeSessionV2 input', () => {
    const result = InitiateFromPreparedSessionInput.safeParse({
      cloudAgentSessionId: validSessionId,
      messageId: validMessageId,
    });

    expect(result.success).toBe(false);
  });
});

describe('API output schemas omit executionId', () => {
  it('StartSessionOutput rejects executionId', () => {
    const result = StartSessionOutput.strict().safeParse({
      cloudAgentSessionId: validSessionId,
      kiloSessionId: 'ses_test',
      executionId: 'exc_01KNSZD4EW94YSDE0WTTJYEQYH',
      messageId: validMessageId,
      delivery: 'queued',
    });
    expect(result.success).toBe(false);
  });

  it('ExecutionResponse rejects executionId', () => {
    const result = ExecutionResponse.strict().safeParse({
      cloudAgentSessionId: validSessionId,
      executionId: 'exc_01KNSZD4EW94YSDE0WTTJYEQYH',
      status: 'started',
      streamUrl: 'https://example.com/stream',
      messageId: validMessageId,
      delivery: 'sent',
    });
    expect(result.success).toBe(false);
  });
});

describe('legacy V2 output schema keeps executionId compatibility', () => {
  it('LegacyExecutionResponse accepts executionId as a messageId compatibility alias', () => {
    const result = LegacyExecutionResponse.safeParse({
      cloudAgentSessionId: validSessionId,
      executionId: validMessageId,
      status: 'started',
      streamUrl: 'https://example.com/stream',
      messageId: validMessageId,
      delivery: 'sent',
    });

    expect(result.success).toBe(true);
  });
});
