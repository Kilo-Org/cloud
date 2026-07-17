import { describe, expect, it } from 'vitest';

import {
  resolveNewSessionSubmitDisabled,
  resolveNewSessionSubmitEnabled,
} from './new-session-submit';

// Inputs that satisfy every precondition. Used as a base and then
// mutated per-case to assert that exactly one input field flips the
// boolean. Keeps the matrix readable.
function validInput(overrides: Partial<Parameters<typeof resolveNewSessionSubmitEnabled>[0]> = {}) {
  return {
    attachmentsHasFailed: false,
    attachmentsIsUploading: false,
    hasPrompt: true,
    isCreating: false,
    isRemoteTargetSelected: false,
    isSubmitting: false,
    model: 'claude-opus-4-7',
    selectedRepo: 'org/repo',
    ...overrides,
  };
}

describe('resolveNewSessionSubmitEnabled', () => {
  // Cloud-Agent (default) regression. The shape of this expression must
  // match the pre-C3a `canCreate && !isCreating && !isSubmitting` exactly
  // when isRemoteTargetSelected is false — i.e. no new field changes the
  // boolean, and the existing flags gate submit exactly as before.
  describe('Cloud Agent (remote target NOT selected)', () => {
    it('is enabled when every precondition is satisfied', () => {
      expect(resolveNewSessionSubmitEnabled(validInput())).toBe(true);
    });

    it('is disabled when the prompt is empty (existing canCreate rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ hasPrompt: false }))).toBe(false);
    });

    it('is disabled when no repository is selected (existing canCreate rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ selectedRepo: '' }))).toBe(false);
    });

    it('is disabled when no model is selected (existing canCreate rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ model: '' }))).toBe(false);
    });

    it('is disabled while attachments are uploading (existing canCreate rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ attachmentsIsUploading: true }))).toBe(
        false
      );
    });

    it('is disabled when any attachment has failed (existing canCreate rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ attachmentsHasFailed: true }))).toBe(
        false
      );
    });

    it('is disabled while a create is in flight (existing isCreating rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ isCreating: true }))).toBe(false);
    });

    it('is disabled while a submit-settle is in flight (existing isSubmitting rule)', () => {
      expect(resolveNewSessionSubmitEnabled(validInput({ isSubmitting: true }))).toBe(false);
    });
  });

  // Safety-critical: whenever a remote target is selected, submit MUST
  // evaluate to disabled regardless of any other field's state. The
  // actual remote-submit wiring is a later slice; until then the
  // button stays inert so we cannot accidentally fire the cloud-agent
  // path with the wrong target.
  describe('Remote target selected', () => {
    const remoteInput = validInput({ isRemoteTargetSelected: true });

    it('is disabled even when every other field is satisfied', () => {
      expect(resolveNewSessionSubmitEnabled(remoteInput)).toBe(false);
    });

    it('is disabled even when the prompt is empty', () => {
      expect(resolveNewSessionSubmitEnabled({ ...remoteInput, hasPrompt: false })).toBe(false);
    });

    it('is disabled even when no repository is selected', () => {
      expect(resolveNewSessionSubmitEnabled({ ...remoteInput, selectedRepo: '' })).toBe(false);
    });

    it('is disabled even when no model is selected', () => {
      expect(resolveNewSessionSubmitEnabled({ ...remoteInput, model: '' })).toBe(false);
    });

    it('is disabled even while not creating / not submitting', () => {
      // Same as the "satisfied" case but the negative is what we care
      // about: no precondition unsticks the button.
      expect(
        resolveNewSessionSubmitEnabled({
          ...remoteInput,
          isCreating: false,
          isSubmitting: false,
        })
      ).toBe(false);
    });
  });
});

describe('resolveNewSessionSubmitDisabled', () => {
  it('is the boolean inverse of resolveNewSessionSubmitEnabled for every input', () => {
    const samples: Parameters<typeof resolveNewSessionSubmitDisabled>[0][] = [
      validInput(),
      validInput({ hasPrompt: false }),
      validInput({ selectedRepo: '' }),
      validInput({ model: '' }),
      validInput({ attachmentsIsUploading: true }),
      validInput({ attachmentsHasFailed: true }),
      validInput({ isCreating: true }),
      validInput({ isSubmitting: true }),
      validInput({ isRemoteTargetSelected: true }),
      validInput({ isRemoteTargetSelected: true, hasPrompt: true, selectedRepo: 'r', model: 'm' }),
    ];
    for (const sample of samples) {
      expect(resolveNewSessionSubmitDisabled(sample)).toBe(!resolveNewSessionSubmitEnabled(sample));
    }
  });
});
