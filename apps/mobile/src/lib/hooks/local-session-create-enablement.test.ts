import { describe, expect, it } from 'vitest';

import { isStartSessionEnabled } from './local-session-create-enablement';

const base = {
  isReadySelection: true,
  hasPrompt: true,
  canSubmit: true,
  isSubmitting: false,
};

describe('isStartSessionEnabled', () => {
  it('is true when all four guards pass', () => {
    expect(isStartSessionEnabled(base)).toBe(true);
  });

  it('is false when the controller has not resolved a ready selection', () => {
    expect(isStartSessionEnabled({ ...base, isReadySelection: false })).toBe(false);
  });

  it('is false when the prompt is blank (hasPrompt false)', () => {
    expect(isStartSessionEnabled({ ...base, hasPrompt: false })).toBe(false);
  });

  it('is false when the hook reports canSubmit false', () => {
    expect(isStartSessionEnabled({ ...base, canSubmit: false })).toBe(false);
  });

  it('is false while a submit is in flight', () => {
    expect(isStartSessionEnabled({ ...base, isSubmitting: true })).toBe(false);
  });

  it('is false when every guard fails', () => {
    expect(
      isStartSessionEnabled({
        isReadySelection: false,
        hasPrompt: false,
        canSubmit: false,
        isSubmitting: true,
      })
    ).toBe(false);
  });
});
