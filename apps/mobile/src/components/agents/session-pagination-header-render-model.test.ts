import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';
import { selectSessionPaginationHeaderRenderModel } from '@/components/agents/session-pagination-header-render-model';
import { type SessionMessageListHeaderStateInputs } from '@/components/agents/session-message-list-state';

function headerModel(overrides: Partial<SessionMessageListHeaderStateInputs> = {}) {
  return selectSessionPaginationHeaderRenderModel({
    isLoadingOlderMessages: false,
    olderMessagesError: null,
    olderMessagesOmittedItemCount: 0,
    ...overrides,
  });
}

function error(kind: OlderMessagesError['kind']): OlderMessagesError {
  return { kind };
}

describe('selectSessionPaginationHeaderRenderModel', () => {
  it('returns hidden when the header has nothing to show', () => {
    expect(headerModel()).toEqual({ kind: 'hidden' });
  });

  it('hides the transient loading placeholder when no omitted banner is showing', () => {
    expect(headerModel({ isLoadingOlderMessages: true })).toEqual({
      kind: 'hidden',
    });
  });

  it('keeps the omitted banner stable while a page is loading', () => {
    expect(headerModel({ isLoadingOlderMessages: true, olderMessagesOmittedItemCount: 5 })).toEqual(
      {
        kind: 'omitted',
        testID: 'session-pagination-header-omitted',
        text: '5 earlier items from this session could not be displayed.',
      }
    );
  });

  it('keeps singular omitted text stable while a page is loading', () => {
    expect(headerModel({ isLoadingOlderMessages: true, olderMessagesOmittedItemCount: 1 })).toEqual(
      {
        kind: 'omitted',
        testID: 'session-pagination-header-omitted',
        text: 'Some earlier items from this session could not be displayed.',
      }
    );
  });

  it('renders retryable text and a Retry CTA', () => {
    expect(headerModel({ olderMessagesError: error('retryable') })).toEqual({
      kind: 'retryable',
      testID: 'session-pagination-header-retryable',
      text: "Couldn't load earlier messages.",
      retry: {
        label: 'Retry',
        accessibilityHint: 'Reattempts the older-messages load for this session.',
      },
    });
  });

  it('renders invalid_data text with no Retry CTA', () => {
    expect(headerModel({ olderMessagesError: error('invalid_data') })).toEqual({
      kind: 'invalid_data',
      testID: 'session-pagination-header-invalid-data',
      text: "Earlier messages aren't available.",
    });
  });

  it('renders too_large text with no Retry CTA', () => {
    expect(headerModel({ olderMessagesError: error('too_large') })).toEqual({
      kind: 'too_large',
      testID: 'session-pagination-header-too-large',
      text: 'Earlier messages are too large to load.',
    });
  });

  it('renders singular omitted text with no Retry CTA', () => {
    expect(headerModel({ olderMessagesOmittedItemCount: 1 })).toEqual({
      kind: 'omitted',
      testID: 'session-pagination-header-omitted',
      text: 'Some earlier items from this session could not be displayed.',
    });
  });

  it('renders plural omitted text with no Retry CTA', () => {
    expect(headerModel({ olderMessagesOmittedItemCount: 5 })).toEqual({
      kind: 'omitted',
      testID: 'session-pagination-header-omitted',
      text: '5 earlier items from this session could not be displayed.',
    });
  });

  it('only includes a retry CTA for the retryable state', () => {
    const hidden = headerModel();
    const loadingHidden = headerModel({ isLoadingOlderMessages: true });
    const loadingOmitted = headerModel({
      isLoadingOlderMessages: true,
      olderMessagesOmittedItemCount: 3,
    });
    const invalidData = headerModel({ olderMessagesError: error('invalid_data') });
    const tooLarge = headerModel({ olderMessagesError: error('too_large') });
    const omitted = headerModel({ olderMessagesOmittedItemCount: 3 });
    const retryable = headerModel({ olderMessagesError: error('retryable') });

    expect('retry' in hidden).toBe(false);
    expect('retry' in loadingHidden).toBe(false);
    expect('retry' in loadingOmitted).toBe(false);
    expect('retry' in invalidData).toBe(false);
    expect('retry' in tooLarge).toBe(false);
    expect('retry' in omitted).toBe(false);
    expect('retry' in retryable).toBe(true);
  });
});
