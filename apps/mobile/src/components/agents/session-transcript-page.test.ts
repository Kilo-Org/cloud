import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSdkStoredMessage } from '@kilocode/cloud-agent-sdk';

import { sessionTranscriptQueryOptions } from './session-transcript-page';

const mocks = vi.hoisted(() => ({
  getSessionMessagesPageQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: {
      getSessionMessagesPage: { query: mocks.getSessionMessagesPageQuery },
    },
  },
}));

function storedMessage(id = 'msg_user_01'): KiloSdkStoredMessage {
  return {
    info: {
      id,
      sessionID: 'ses_123',
      role: 'user',
      time: { created: 1_761_000_000_100 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [{ id: `${id}-text`, sessionID: 'ses_123', messageID: id, type: 'text', text: 'hi' }],
  };
}

describe('sessionTranscriptQueryOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keys the transcript by the shared key and the session id', () => {
    expect(sessionTranscriptQueryOptions('ses_123').queryKey).toEqual([
      'session-transcript-page',
      'ses_123',
    ]);
  });

  it('reads the newest page through the paged endpoint', async () => {
    const message = storedMessage();
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: { messages: [message], nextCursor: null, omittedItemCount: 0 },
    });

    await expect(sessionTranscriptQueryOptions('ses_123').queryFn()).resolves.toEqual([message]);
    expect(mocks.getSessionMessagesPageQuery).toHaveBeenCalledWith({ session_id: 'ses_123' });
  });

  it('maps a null history to an empty transcript', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: null,
    });

    await expect(sessionTranscriptQueryOptions('ses_123').queryFn()).resolves.toEqual([]);
  });

  it('rejects with the retryable code so the preview keeps its retry action', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: { kind: 'retryable_failure', phase: 'message_scan' },
    });

    await expect(sessionTranscriptQueryOptions('ses_123').queryFn()).rejects.toMatchObject({
      message: 'Session history temporarily unavailable',
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('rejects an oversized page with a terminal code, so no retry is offered', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: { kind: 'too_large', maximumBytes: 1024, phase: 'page_parts' },
    });

    await expect(sessionTranscriptQueryOptions('ses_123').queryFn()).rejects.toMatchObject({
      message: 'Session history too large to load',
      code: 'UNPROCESSABLE_CONTENT',
    });
  });
});
