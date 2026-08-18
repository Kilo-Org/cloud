import { describe, expect, it, vi } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';

import {
  buildReportAiResponseErrorToast,
  buildReportAiResponseInput,
  classifyReportAiResponseFailure,
  reportAiResponseSubmittedToast,
  shouldShowReportAiResponse,
} from './report-ai-response';

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1_700_000_000_000 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'test',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function userInfo(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'u-1',
    sessionID: 'ses-1',
    role: 'user',
    time: { created: 1_700_000_000_000 },
    agent: 'test',
    model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    ...overrides,
  };
}

function textPart(text: string, id = 'p-text'): Part {
  return { id, sessionID: 'ses-1', messageID: 'msg-1', type: 'text', text };
}

function stepFinish(overrides: Partial<StepFinishPart> = {}): StepFinishPart {
  return {
    id: 'p-finish',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function stepFinishWithRouted(routed: { providerID: string; modelID: string }): StepFinishPart {
  return Object.assign(stepFinish(), { model: routed }) as StepFinishPart;
}

function storedMessage(info: AssistantMessage | UserMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

describe('shouldShowReportAiResponse — visibility (empty)', () => {
  it('shows for an assistant message with an id', () => {
    expect(shouldShowReportAiResponse(storedMessage(assistantInfo(), [textPart('hi')]))).toBe(true);
  });

  it('hides for a user message', () => {
    expect(shouldShowReportAiResponse(storedMessage(userInfo(), [textPart('hi')]))).toBe(false);
  });

  it('hides for an assistant message with an empty id', () => {
    expect(shouldShowReportAiResponse(storedMessage(assistantInfo({ id: '' })))).toBe(false);
  });

  it('hides for a null message', () => {
    expect(shouldShowReportAiResponse(null)).toBe(false);
  });
});

describe('buildReportAiResponseInput — happy', () => {
  it('builds the minimized input with no body', () => {
    const message = storedMessage(assistantInfo(), [textPart('secret response body')]);
    const input = buildReportAiResponseInput(message);

    expect(input).toEqual({
      surface: 'ai_output',
      targetKind: 'message',
      targetId: 'msg-1',
      modelId: 'claude-sonnet-4',
      sessionId: 'ses-1',
      reason: 'other',
      context: { platform: 'mobile' },
    });
    expect(input).not.toHaveProperty('body');
    expect(JSON.stringify(input)).not.toContain('secret response body');
  });

  it('prefers the routed model id over the info-level model id', () => {
    const info = assistantInfo({ modelID: 'kilo-auto/efficient' });
    const message = storedMessage(info, [
      textPart('hi'),
      stepFinishWithRouted({ providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' }),
    ]);
    expect(buildReportAiResponseInput(message)?.modelId).toBe('anthropic/claude-sonnet-4');
  });

  it('falls back to the info-level model id when no routed stamp exists', () => {
    const message = storedMessage(assistantInfo({ modelID: 'claude-sonnet-4' }), [textPart('hi')]);
    expect(buildReportAiResponseInput(message)?.modelId).toBe('claude-sonnet-4');
  });

  it('keeps the info-level model id when no routed stamp exists', () => {
    const message = storedMessage(assistantInfo({ modelID: '', providerID: '' }), [textPart('hi')]);
    expect(buildReportAiResponseInput(message)?.modelId).toBe('');
  });
});

describe('buildReportAiResponseInput — empty', () => {
  it('returns null for a user message', () => {
    expect(buildReportAiResponseInput(storedMessage(userInfo(), [textPart('hi')]))).toBeNull();
  });

  it('returns null for an assistant message with an empty id', () => {
    expect(buildReportAiResponseInput(storedMessage(assistantInfo({ id: '' })))).toBeNull();
  });
});

describe('classifyReportAiResponseFailure — terminal (non-retryable)', () => {
  it.each(['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'UNPROCESSABLE_CONTENT'])(
    'classifies %s as terminal',
    code => {
      const failure = classifyReportAiResponseFailure({ data: { code } });
      expect(failure.retryable).toBe(false);
      expect(failure.message).toBe("This response can't be reported.");
    }
  );
});

describe('classifyReportAiResponseFailure — retryable', () => {
  it('classifies a 5xx code as retryable', () => {
    const failure = classifyReportAiResponseFailure({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(failure.retryable).toBe(true);
    expect(failure.message).toBe("Couldn't report this response.");
  });

  it('classifies a network TypeError as retryable', () => {
    expect(classifyReportAiResponseFailure(new TypeError('Network request failed')).retryable).toBe(
      true
    );
  });

  it('classifies an error with no tRPC code as retryable', () => {
    expect(classifyReportAiResponseFailure(new Error('boom')).retryable).toBe(true);
    expect(classifyReportAiResponseFailure(undefined).retryable).toBe(true);
  });
});

describe('reportAiResponseSubmittedToast — submitted (happy)', () => {
  it('returns the receipt id and never the message body', () => {
    const toast = reportAiResponseSubmittedToast('receipt-123');
    expect(toast).toBe('Report submitted. Receipt receipt-123');
    expect(toast).not.toContain('secret response body');
  });
});

describe('buildReportAiResponseErrorToast — retryable unhappy', () => {
  it('carries a Retry action that re-runs the supplied retry callback', () => {
    const retry = vi.fn<() => void>();
    const failure = classifyReportAiResponseFailure({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    const errorToast = buildReportAiResponseErrorToast(failure, retry);

    expect(errorToast.message).toBe("Couldn't report this response.");
    expect(errorToast.action).toEqual({ label: 'Retry', onClick: expect.any(Function) });
    expect(retry).not.toHaveBeenCalled();

    errorToast.action?.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('carries a Retry action for a network failure', () => {
    const failure = classifyReportAiResponseFailure(new TypeError('Network request failed'));
    const errorToast = buildReportAiResponseErrorToast(failure, vi.fn<() => void>());
    expect(errorToast.action?.label).toBe('Retry');
  });
});

describe('buildReportAiResponseErrorToast — terminal (non-retryable)', () => {
  it('carries no Retry action', () => {
    const failure = classifyReportAiResponseFailure({ data: { code: 'FORBIDDEN' } });
    const errorToast = buildReportAiResponseErrorToast(failure, vi.fn<() => void>());

    expect(errorToast.message).toBe("This response can't be reported.");
    expect(errorToast.action).toBeUndefined();
  });
});
