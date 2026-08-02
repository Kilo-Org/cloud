import { describe, expect, it } from 'vitest';

import { shouldAutoSendPrefilledShare } from './composer-auto-send';

function makeTrue(): ReturnType<typeof shouldAutoSendPrefilledShare> extends boolean
  ? Parameters<typeof shouldAutoSendPrefilledShare>[0]
  : never {
  return {
    autoSend: true,
    alreadyFired: false,
    shareDelivered: true,
    hasText: true,
    hasAttachments: false,
    attachmentsEnabled: true,
    canSend: true,
    isUploading: false,
    hasFailedAttachments: false,
  };
}

describe('shouldAutoSendPrefilledShare', () => {
  it('returns false when autoSend is false', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), autoSend: false })).toBe(false);
  });

  it('returns false when alreadyFired is true', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), alreadyFired: true })).toBe(false);
  });

  it('returns false when shareDelivered is false', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), shareDelivered: false })).toBe(false);
  });

  it('returns false when hasText is false', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), hasText: false })).toBe(false);
  });

  it('returns false when canSend is false', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), canSend: false })).toBe(false);
  });

  it('returns false when isUploading is true', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), isUploading: true })).toBe(false);
  });

  it('returns false when hasFailedAttachments is true', () => {
    expect(shouldAutoSendPrefilledShare({ ...makeTrue(), hasFailedAttachments: true })).toBe(false);
  });

  it('returns false when hasAttachments is true but attachmentsEnabled is false', () => {
    expect(
      shouldAutoSendPrefilledShare({
        ...makeTrue(),
        hasAttachments: true,
        attachmentsEnabled: false,
      })
    ).toBe(false);
  });

  it('returns true when all gates pass', () => {
    expect(shouldAutoSendPrefilledShare(makeTrue())).toBe(true);
  });

  it('returns true when hasAttachments is true and attachmentsEnabled is true', () => {
    expect(
      shouldAutoSendPrefilledShare({
        ...makeTrue(),
        hasAttachments: true,
        attachmentsEnabled: true,
      })
    ).toBe(true);
  });
});
