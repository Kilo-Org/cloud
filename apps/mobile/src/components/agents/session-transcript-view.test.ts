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
        historyState: { kind: 'pending', reason: 'first-page' },
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
        historyState: { kind: 'pending', reason: 'first-page' },
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
        historyState: { kind: 'pending', reason: 'first-page' },
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
        historyState: { kind: 'pending', reason: 'first-page' },
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
          historyState: { kind: 'settled' },
        })
      ).toBe('empty');
    }
  );

  it('shows the empty state for a zero-item settled transcript with no cursor', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: false,
        olderMessagesError: null,
        historyState: { kind: 'settled' },
      })
    ).toBe('empty');
  });

  it('gives a first page that settled unreadable its own failure, not the empty state', () => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: false,
        olderMessagesError: null,
        historyState: { kind: 'unreadable' },
      })
    ).toBe('history-error');
  });

  it.each(['first-page', 'streaming'] as const)(
    'keeps the skeleton for either reason a first page is pending (%s)',
    reason => {
      expect(
        resolveSessionTranscriptView({
          transcriptItemCount: 0,
          hasStatusIndicator: false,
          hasOlderMessages: false,
          olderMessagesError: null,
          historyState: { kind: 'pending', reason },
        })
      ).toBe('history-pending');
    }
  );

  it.each([
    { kind: 'pending', reason: 'first-page' },
    { kind: 'pending', reason: 'streaming' },
    { kind: 'unreadable' },
  ] as const)('keeps an older-page error above the first-page state ($kind)', historyState => {
    expect(
      resolveSessionTranscriptView({
        transcriptItemCount: 0,
        hasStatusIndicator: false,
        hasOlderMessages: true,
        olderMessagesError: { kind: 'retryable' },
        historyState,
      })
    ).toBe('older-error');
  });
});
