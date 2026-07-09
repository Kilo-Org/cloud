import { describe, expect, it } from 'vitest';
import {
  ExecutionResponse,
  GetMessageResultInput,
  GetMessageResultOutput,
  GetSessionOutput,
  InitiateFromPreparedSessionInput,
  LegacyExecutionResponse,
  PrepareSessionInput,
  SendMessageInput,
  SendMessageV2Input,
  StartSessionOutput,
  StartSessionInput,
  branchNameSchema,
} from './schemas.js';
import { parseCanonicalBitbucketCloneUrl } from '../types.js';

const validMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const validSessionId = 'agent_12345678-1234-1234-1234-123456789012';
const validImages = {
  path: '123e4567-e89b-12d3-a456-426614174000',
  files: ['123e4567-e89b-12d3-a456-426614174001.png'],
};
const validAttachments = {
  path: '123e4567-e89b-12d3-a456-426614174000',
  files: ['123e4567-e89b-12d3-a456-426614174001.csv'],
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

  it('accepts document attachments on grouped start and send messages', () => {
    expect(
      StartSessionInput.parse({
        ...baseStartInput,
        message: { prompt: 'Summarize the CSV', attachments: validAttachments },
      }).message.attachments
    ).toEqual(validAttachments);
    expect(
      SendMessageInput.parse({
        cloudAgentSessionId: validSessionId,
        message: { prompt: 'Read this document', attachments: validAttachments },
      }).message.attachments
    ).toEqual(validAttachments);
  });

  it('continues accepting legacy images and rejects ambiguous grouped attachment payloads', () => {
    expect(
      SendMessageInput.safeParse({
        cloudAgentSessionId: validSessionId,
        message: { prompt: 'Read the image', images: validImages },
      }).success
    ).toBe(true);
    expect(
      StartSessionInput.safeParse({
        ...baseStartInput,
        message: { prompt: 'ambiguous', images: validImages, attachments: validAttachments },
      }).success
    ).toBe(false);
    expect(
      SendMessageInput.safeParse({
        cloudAgentSessionId: validSessionId,
        message: { prompt: 'ambiguous', images: validImages, attachments: validAttachments },
      }).success
    ).toBe(false);
  });

  it('preserves the grouped send payload shape', () => {
    const input = {
      cloudAgentSessionId: validSessionId,
      message: {
        prompt: 'Continue with the queued turn',
        attachments: validAttachments,
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

  it('requires stable workspace and repository UUIDs for Bitbucket starts', () => {
    const repository = {
      type: 'bitbucket' as const,
      url: 'https://bitbucket.org/acme/repo.git',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    };
    expect(StartSessionInput.safeParse({ ...baseStartInput, repository }).success).toBe(true);
    expect(
      StartSessionInput.safeParse({
        ...baseStartInput,
        repository: { type: 'bitbucket', url: repository.url },
      }).success
    ).toBe(false);
  });

  it('accepts an optional integration id on Bitbucket starts', () => {
    expect(
      StartSessionInput.safeParse({
        ...baseStartInput,
        repository: {
          type: 'bitbucket' as const,
          url: 'https://bitbucket.org/acme/repo.git',
          workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
          repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
          bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        },
      }).success
    ).toBe(true);
  });
});

describe('legacy live attachment input compatibility', () => {
  it('accepts shell-safe Git branch punctuation used by current-branch reviews', () => {
    const branch = 'feature/alex+metadata@v2,fix=1#manual';

    expect(branchNameSchema.safeParse(branch).success).toBe(true);
    expect(
      PrepareSessionInput.safeParse({
        prompt: 'Review the current branch',
        mode: 'code',
        model: 'claude-sonnet-4-5-20250929',
        githubRepo: 'acme/repo',
        upstreamBranch: branch,
      }).success
    ).toBe(true);
  });

  it('rejects Git-invalid or shell-unsafe branch names', () => {
    const invalidBranches = ['feature/a..b', 'feature/@{bad', "feature/unsafe'quote"];

    for (const branch of invalidBranches) {
      expect(branchNameSchema.safeParse(branch).success).toBe(false);
    }
  });

  it('requires paired Bitbucket identity fields on prepareSession', () => {
    const input = {
      prompt: 'Update the repository',
      mode: 'code',
      model: 'claude-sonnet-4-5-20250929',
      gitUrl: 'https://bitbucket.org/acme/repo.git',
      platform: 'bitbucket',
      bitbucketWorkspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      bitbucketRepositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    };
    expect(PrepareSessionInput.safeParse(input).success).toBe(true);
    expect(
      PrepareSessionInput.safeParse({ ...input, bitbucketRepositoryUuid: undefined }).success
    ).toBe(false);
    expect(PrepareSessionInput.safeParse({ ...input, platform: 'gitlab' }).success).toBe(false);
  });

  it('requires complete fenced context only for Bitbucket code-review sessions', () => {
    const input = {
      prompt: 'Review the pull request',
      mode: 'code',
      model: 'claude-sonnet-4-5-20250929',
      gitUrl: 'https://bitbucket.org/acme/repo.git',
      platform: 'bitbucket' as const,
      kilocodeOrganizationId: '123e4567-e89b-12d3-a456-426614174099',
      bitbucketWorkspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      bitbucketWorkspaceSlug: 'acme',
      bitbucketRepositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      bitbucketRepositorySlug: 'repo',
      bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
      bitbucketPullRequestId: 42,
      bitbucketExpectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      createdOnPlatform: 'code-review',
      callbackTarget: {
        url: 'https://kilo.example/api/internal/code-review-status/123e4567-e89b-12d3-a456-426614174023?attemptId=attempt-1',
      },
    };

    expect(PrepareSessionInput.safeParse(input).success).toBe(true);
    for (const field of [
      'kilocodeOrganizationId',
      'bitbucketWorkspaceSlug',
      'bitbucketRepositorySlug',
      'bitbucketIntegrationId',
      'bitbucketPullRequestId',
      'bitbucketExpectedHeadSha',
      'callbackTarget',
    ] as const) {
      expect(PrepareSessionInput.safeParse({ ...input, [field]: undefined }).success).toBe(false);
    }
    expect(
      PrepareSessionInput.safeParse({
        ...input,
        gitUrl: 'https://bitbucket.org/acme/repo',
      }).success
    ).toBe(false);
    expect(
      PrepareSessionInput.safeParse({
        ...input,
        bitbucketRepositorySlug: 'different-repo',
      }).success
    ).toBe(false);
    expect(
      PrepareSessionInput.safeParse({
        ...input,
        createdOnPlatform: 'cloud-agent-web',
      }).success
    ).toBe(false);
    expect(
      PrepareSessionInput.safeParse({
        ...input,
        platform: 'gitlab',
        gitUrl: 'https://gitlab.com/acme/repo.git',
        bitbucketWorkspaceUuid: undefined,
        bitbucketRepositoryUuid: undefined,
      }).success
    ).toBe(false);
  });

  it('accepts document attachments on prepareSession while retaining images', () => {
    const basePrepareInput = {
      prompt: 'Summarize this document',
      mode: 'code',
      model: 'claude-sonnet-4-5-20250929',
      githubRepo: 'acme/repo',
    };

    expect(
      PrepareSessionInput.safeParse({ ...basePrepareInput, attachments: validAttachments }).success
    ).toBe(true);
    expect(
      PrepareSessionInput.safeParse({ ...basePrepareInput, images: validImages }).success
    ).toBe(true);
    expect(
      PrepareSessionInput.safeParse({
        ...basePrepareInput,
        attachments: validAttachments,
        images: validImages,
      }).success
    ).toBe(false);
  });
});

describe('sendMessageV2 input compatibility', () => {
  it('normalizes nested prompt payloads with document attachments from web callers', () => {
    const result = SendMessageV2Input.safeParse({
      cloudAgentSessionId: validSessionId,
      messageId: validMessageId,
      payload: { type: 'prompt', ...basePromptInput },
      attachments: validAttachments,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual({
      cloudAgentSessionId: validSessionId,
      messageId: validMessageId,
      attachments: validAttachments,
      ...basePromptInput,
    });
  });

  it('continues accepting legacy images and rejects ambiguous prompt attachments', () => {
    expect(
      SendMessageV2Input.safeParse({
        cloudAgentSessionId: validSessionId,
        payload: { type: 'prompt', ...basePromptInput },
        images: validImages,
      }).success
    ).toBe(true);
    expect(
      SendMessageV2Input.safeParse({
        cloudAgentSessionId: validSessionId,
        payload: { type: 'prompt', ...basePromptInput },
        attachments: validAttachments,
        images: validImages,
      }).success
    ).toBe(false);
  });

  it('rejects attachment descriptors on nested command payloads', () => {
    for (const descriptor of [{ images: validImages }, { attachments: validAttachments }]) {
      expect(
        SendMessageV2Input.safeParse({
          cloudAgentSessionId: validSessionId,
          payload: {
            type: 'command',
            command: 'compact',
            arguments: '--aggressive',
          },
          ...descriptor,
        }).success
      ).toBe(false);
    }
  });
});

describe('Bitbucket clone URL parsing', () => {
  it('keeps canonical Bitbucket repository identity limited to HTTPS clone URLs', () => {
    expect(parseCanonicalBitbucketCloneUrl('https://bitbucket.org/acme/repo.git')).toEqual({
      workspaceSlug: 'acme',
      repositorySlug: 'repo',
    });
    expect(parseCanonicalBitbucketCloneUrl('ssh://git@bitbucket.org/acme/repo.git')).toBeNull();
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

describe('getMessageResult contract', () => {
  const baseOutput = {
    cloudAgentSessionId: validSessionId,
    messageId: validMessageId,
    status: 'completed' as const,
    createdAt: 1,
  };

  it('requires an exact lookup input while rejecting invalid or unknown fields', () => {
    expect(GetMessageResultInput.safeParse({ cloudAgentSessionId: validSessionId }).success).toBe(
      false
    );
    expect(
      GetMessageResultInput.safeParse({
        cloudAgentSessionId: validSessionId,
        messageId: validMessageId,
      }).success
    ).toBe(true);
    expect(GetMessageResultInput.safeParse({ cloudAgentSessionId: 'agent_invalid' }).success).toBe(
      false
    );
    expect(
      GetMessageResultInput.safeParse({ cloudAgentSessionId: validSessionId, messageId: 'msg_bad' })
        .success
    ).toBe(false);
    expect(
      GetMessageResultInput.safeParse({ cloudAgentSessionId: validSessionId, unknown: true })
        .success
    ).toBe(false);
  });

  it('accepts public statuses and allowlisted structured result fields', () => {
    for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted']) {
      expect(GetMessageResultOutput.safeParse({ ...baseOutput, status }).success).toBe(true);
    }
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        queuedAt: 2,
        acceptedAt: 3,
        terminalAt: 4,
        completionSource: 'assistant_message_event',
        gateResult: 'fail',
        assistant: { messageId: 'assistant_1', text: 'safe answer' },
      }).success
    ).toBe(true);
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        status: 'failed',
        queuedAt: 2,
        acceptedAt: 3,
        terminalAt: 4,
        completionSource: 'wrapper_failure',
        failure: {
          stage: 'agent_activity',
          code: 'assistant_error',
          attempts: 2,
          retryable: false,
        },
      }).success
    ).toBe(true);
  });

  it('requires retryability on failed and interrupted failure details', () => {
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        status: 'interrupted',
        failure: { retryable: true },
      }).success
    ).toBe(true);
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        status: 'failed',
        failure: { code: 'assistant_error' },
      }).success
    ).toBe(false);
  });

  it('fails closed on contradictory lifecycle result fields', () => {
    for (const output of [
      { ...baseOutput, status: 'queued', acceptedAt: 2 },
      { ...baseOutput, status: 'queued', terminalAt: 2 },
      { ...baseOutput, status: 'running', completionSource: 'assistant_message_event' },
      { ...baseOutput, status: 'queued', failure: { attempts: 1, retryable: true } },
      { ...baseOutput, status: 'failed', assistant: { messageId: 'assistant_1', text: 'wrong' } },
      { ...baseOutput, status: 'interrupted', gateResult: 'fail' },
    ]) {
      expect(GetMessageResultOutput.safeParse(output).success).toBe(false);
    }
  });

  it('fails closed on extra top-level and nested fields', () => {
    for (const extra of [
      { error: 'token' },
      { failureReason: 'token' },
      { callbackTarget: { url: 'https://example.com', headers: { Authorization: 'token' } } },
    ]) {
      expect(GetMessageResultOutput.safeParse({ ...baseOutput, ...extra }).success).toBe(false);
    }
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        status: 'failed',
        failure: { attempts: -1 },
      }).success
    ).toBe(false);
    expect(
      GetMessageResultOutput.safeParse({
        ...baseOutput,
        status: 'failed',
        failure: { error: 'token' },
      }).success
    ).toBe(false);
    expect(
      GetMessageResultOutput.safeParse({ ...baseOutput, assistant: { text: 'missing identity' } })
        .success
    ).toBe(false);
    expect(
      GetMessageResultOutput.safeParse({ ...baseOutput, assistant: { parts: [], info: {} } })
        .success
    ).toBe(false);
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
