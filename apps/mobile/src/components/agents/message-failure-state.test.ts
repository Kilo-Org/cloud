import { describe, expect, it } from 'vitest';

import { type MessageInfo } from '@kilocode/cloud-agent-sdk';

import { NON_RETRYABLE_ASSISTANT_ERRORS, selectMessageFailure } from './message-failure-state';

function userInfo(): MessageInfo {
  return {
    id: 'u1',
    sessionID: 'ses_1',
    role: 'user',
    time: { created: 1_761_000_000_000 },
    agent: 'build',
    model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
  };
}

type AssistantError = NonNullable<Extract<MessageInfo, { role: 'assistant' }>['error']>;

function assistantInfo(errorName: string): MessageInfo {
  return {
    id: 'a1',
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created: 1_761_000_000_000 },
    // Deliberately carries raw provider text; the helper must never surface it.
    error: { name: errorName, data: { message: 'RAW_PROVIDER_TEXT' } } as unknown as AssistantError,
    parentID: 'u1',
    modelID: 'anthropic/claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function assistantInfoWithoutError(): MessageInfo {
  const info = assistantInfo('ProviderAuthError') as Extract<MessageInfo, { role: 'assistant' }>;
  delete info.error;
  return info;
}

describe('selectMessageFailure', () => {
  it('returns null when there is no failed delivery and no assistant error', () => {
    expect(selectMessageFailure({ info: userInfo() })).toBeNull();
    expect(selectMessageFailure({ info: assistantInfo('UnknownError') })).not.toBeNull();
  });

  it('returns null for a queued delivery state', () => {
    expect(
      selectMessageFailure({ info: userInfo(), deliveryState: { status: 'queued' } })
    ).toBeNull();
  });

  describe('delivery', () => {
    it('maps every delivery reason to fixed copy and never emits raw error text', () => {
      const cases = [
        { reason: 'interrupted', title: 'Failed to deliver', detail: 'You stopped this message.' },
        {
          reason: 'exhausted',
          title: 'Failed to deliver',
          detail: 'We could not deliver this message after several attempts.',
        },
      ] as const;

      for (const { reason, title, detail } of cases) {
        const result = selectMessageFailure({
          info: userInfo(),
          deliveryState: { status: 'failed', error: 'RAW_TRANSPORT_TEXT', reason },
        });
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('delivery');
        expect(result?.title).toBe(title);
        expect(result?.detail).toBe(detail);
        expect(result?.title).not.toContain('RAW_TRANSPORT_TEXT');
        expect(result?.detail).not.toContain('RAW_TRANSPORT_TEXT');
        // The raw transport text stays reachable behind the copy action only.
        expect(result?.copyDetail).toBe('RAW_TRANSPORT_TEXT');
        expect(result?.canRetry).toBe(true);
        expect(result?.canCopy).toBe(true);
      }
    });

    it('states an agent-execution failure once, in the assistant-failure copy', () => {
      const result = selectMessageFailure({
        info: userInfo(),
        deliveryState: { status: 'failed', error: 'RAW_TRANSPORT_TEXT', reason: 'execution' },
      });
      expect(result).not.toBeNull();
      expect(result?.kind).toBe('delivery');
      expect(result?.title).toBe('Response failed');
      expect(result?.detail).toBeNull();
      expect(result?.copyDetail).toBe('RAW_TRANSPORT_TEXT');
      expect(result?.canRetry).toBe(true);
      expect(result?.canCopy).toBe(true);
    });

    it('exposes no copy detail when the delivery failure carries no transport text', () => {
      const result = selectMessageFailure({
        info: userInfo(),
        deliveryState: { status: 'failed', error: '', reason: 'exhausted' },
      });
      expect(result?.copyDetail).toBe('');
    });
  });

  describe('assistant', () => {
    it('returns null for an assistant info with no error', () => {
      expect(selectMessageFailure({ info: assistantInfoWithoutError() })).toBeNull();
    });

    it('never carries a copy detail for an assistant row', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.copyDetail).toBe('');
    });

    it('derives fixed copy from a known error name and never emits provider text', () => {
      const result = selectMessageFailure({ info: assistantInfo('ProviderAuthError') });
      expect(result).not.toBeNull();
      expect(result?.kind).toBe('assistant');
      expect(result?.title).toBe('Response failed');
      expect(result?.detail).toBe('The provider rejected the request.');
      expect(result?.detail).not.toContain('RAW_PROVIDER_TEXT');
      expect(result?.canCopy).toBe(false);
    });

    it('adds no detail line for an unknown error name, which the title states', () => {
      const result = selectMessageFailure({ info: assistantInfo('UnknownError') });
      expect(result?.title).toBe('Response failed');
      expect(result?.detail).toBeNull();
      expect(JSON.stringify(result)).not.toContain('RAW_PROVIDER_TEXT');
    });

    it('sets canRetry false only for NON_RETRYABLE_ASSISTANT_ERRORS', () => {
      for (const name of NON_RETRYABLE_ASSISTANT_ERRORS) {
        const result = selectMessageFailure({ info: assistantInfo(name) });
        expect(result?.canRetry).toBe(false);
      }
    });

    it('sets canRetry true for an assistant error outside the non-retryable set', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.canRetry).toBe(true);
    });

    it('never sets canCopy true for an assistant row', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.canCopy).toBe(false);
    });
  });
});
