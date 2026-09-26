import { describe, expect, it } from 'vitest';

import { resolveSessionTranscriptView } from '@/components/agents/session-transcript-view';

describe('resolveSessionTranscriptView', () => {
  it('lists whenever the merged transcript has items', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 1,
        hasStatusIndicator: true,
        hasOlderMessages: true,
        olderMessagesError: null,
      })
    ).toBe('list');
  });

  it('shows the status indicator for a zero-item transcript while one is visible', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: true,
        hasOlderMessages: false,
        olderMessagesError: null,
      })
    ).toBe('status');
  });

  it('keeps the older-page loader for a zero-item transcript with a live cursor', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: true,
        olderMessagesError: null,
      })
    ).toBe('older-loading');
  });

  it('gives a retryable older-page failure its own retryable view (not the empty state)', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: true,
        olderMessagesError: { kind: 'retryable' },
      })
    ).toBe('older-error');
  });

  it.each([{ kind: 'invalid_data' }, { kind: 'too_large' }] as const)(
    'falls through to the empty state for a terminal older-page error ($kind)',
    olderMessagesError => {
      expect(
        resolveSessionTranscriptView({
          transcriptItemCount: 0,
          hasStatusIndicator: false,
          hasOlderMessages: true,
          olderMessagesError,
        })
      ).toBe('empty');
    }
  );

  it('shows the empty state for a zero-item transcript with no cursor', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: false,
        olderMessagesError: null,
      })
    ).toBe('empty');
  });
});
