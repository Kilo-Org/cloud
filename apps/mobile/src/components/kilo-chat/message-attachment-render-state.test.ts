import { describe, expect, it } from 'vitest';

import {
  getAttachmentImageRenderState,
  getAttachmentOpenErrorMessage,
  getFreshAttachmentPreviewUrl,
} from './message-attachment-open';

describe('message attachment render state', () => {
  it('maps image query state to render states', () => {
    expect(getAttachmentImageRenderState({ hasUrl: false, isError: false, isLoading: true })).toBe(
      'loading'
    );
    expect(getAttachmentImageRenderState({ hasUrl: false, isError: true, isLoading: false })).toBe(
      'error'
    );
    expect(getAttachmentImageRenderState({ hasUrl: true, isError: false, isLoading: false })).toBe(
      'ready'
    );
  });

  it('uses native open error copy', () => {
    expect(getAttachmentOpenErrorMessage()).toBe(
      "Couldn't open attachment. Check your connection and try again."
    );
  });

  it('only opens image preview when a fresh URL is available', () => {
    expect(getFreshAttachmentPreviewUrl({ url: 'https://example.com/image.png' })).toBe(
      'https://example.com/image.png'
    );
    expect(getFreshAttachmentPreviewUrl({ url: null })).toBeNull();
    expect(getFreshAttachmentPreviewUrl(undefined)).toBeNull();
  });
});
