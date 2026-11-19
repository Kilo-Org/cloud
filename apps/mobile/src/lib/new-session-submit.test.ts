/* eslint-disable max-lines -- one matrix per gate (submit, start, continue, blocked reason), each pinning an independent field flip. */
import { describe, expect, it } from 'vitest';

import {
  resolveContinueStartDisabled,
  resolveNewSessionConnectProvider,
  resolveNewSessionProfileGate,
  resolveNewSessionStartBlockedReason,
  resolveNewSessionStartDisabled,
  resolveNewSessionSubmitDisabled,
  resolveNewSessionSubmitEnabled,
  resolveRemoteStartMissingContent,
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

function continueInput(
  overrides: Partial<Parameters<typeof resolveContinueStartDisabled>[0]> = {}
) {
  return {
    isCreating: false,
    isSubmitting: false,
    isSpawningRemote: false,
    model: 'claude-opus-4-7',
    selectedRepo: 'org/repo',
    selectedRepositoryResolved: true,
    isRemoteTargetSelected: false,
    instanceCatalogLoading: false,
    instanceHasSessionClone: true,
    cloneImportFailureKey: null,
    isModelUnavailable: false,
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

describe('resolveNewSessionStartDisabled', () => {
  function startInput(
    overrides: Partial<Parameters<typeof resolveNewSessionStartDisabled>[0]> = {}
  ): Parameters<typeof resolveNewSessionStartDisabled>[0] {
    return {
      ...validInput(),
      selectedRepositoryResolved: true,
      profileGate: { kind: 'ready' },
      ...overrides,
    };
  }

  it('is enabled when every precondition is satisfied and the profile read settled', () => {
    // A read that failed with no pick is `ready`: the create submits no profile
    // id and the server applies its default, so the failure is not a blocker.
    expect(resolveNewSessionStartDisabled(startInput())).toBe(false);
  });

  it('blocks Start while the profile query is loading', () => {
    expect(resolveNewSessionStartDisabled(startInput({ profileGate: { kind: 'loading' } }))).toBe(
      true
    );
  });

  it('blocks Start when a picked profile could not be read, even with a repository selected', () => {
    expect(
      resolveNewSessionStartDisabled(startInput({ profileGate: { kind: 'override-error' } }))
    ).toBe(true);
    expect(
      resolveNewSessionStartDisabled(
        startInput({ selectedRepo: '', profileGate: { kind: 'override-error' } })
      )
    ).toBe(true);
  });

  it('enables Start again once the retried profile read resolves the pick', () => {
    // The gate comes from the read's flags, so the retry is a real transition:
    // the settled error blocks Start, and the read that resolves the same pick
    // afterwards enables it with no other input changed.
    expect(
      resolveNewSessionStartDisabled(
        startInput({
          profileGate: resolveNewSessionProfileGate({
            isLoading: false,
            isError: true,
            hasOverride: true,
          }),
        })
      )
    ).toBe(true);
    expect(
      resolveNewSessionStartDisabled(
        startInput({
          profileGate: resolveNewSessionProfileGate({
            isLoading: false,
            isError: false,
            hasOverride: true,
          }),
        })
      )
    ).toBe(false);
  });
  it('non-clone empty prompt stays disabled through the ordinary gate', () => {
    expect(resolveNewSessionStartDisabled(startInput({ hasPrompt: false }))).toBe(true);
  });

  it('blocks Start when the selected repo key no longer resolves to a row (stale selection)', () => {
    expect(
      resolveNewSessionStartDisabled(
        startInput({ selectedRepo: 'github:owner/repo', selectedRepositoryResolved: false })
      )
    ).toBe(true);
  });

  it('keeps Start enabled when the selected repo key still resolves to a row', () => {
    expect(
      resolveNewSessionStartDisabled(
        startInput({ selectedRepo: 'github:owner/repo', selectedRepositoryResolved: true })
      )
    ).toBe(false);
  });
});

describe('resolveNewSessionProfileGate', () => {
  it('lets loading outrank a settled error, because a retry keeps the error status', () => {
    expect(
      resolveNewSessionProfileGate({ isLoading: true, isError: true, hasOverride: true })
    ).toEqual({ kind: 'loading' });
    expect(
      resolveNewSessionProfileGate({ isLoading: true, isError: false, hasOverride: false })
    ).toEqual({ kind: 'loading' });
  });

  it('reads an error with no pick as ready, so the create falls to the server default', () => {
    expect(
      resolveNewSessionProfileGate({ isLoading: false, isError: true, hasOverride: false })
    ).toEqual({ kind: 'ready' });
  });

  it('reports an error with a pick as needing the pick confirmed by a retry', () => {
    expect(
      resolveNewSessionProfileGate({ isLoading: false, isError: true, hasOverride: true })
    ).toEqual({ kind: 'override-error' });
  });

  it('reads any settled success as ready, with or without a pick', () => {
    expect(
      resolveNewSessionProfileGate({ isLoading: false, isError: false, hasOverride: true })
    ).toEqual({ kind: 'ready' });
    expect(
      resolveNewSessionProfileGate({ isLoading: false, isError: false, hasOverride: false })
    ).toEqual({ kind: 'ready' });
  });
});

describe('resolveRemoteStartMissingContent', () => {
  it('reports missing content for an empty composer', () => {
    expect(resolveRemoteStartMissingContent({ hasPrompt: false, hasAttachments: false })).toBe(
      true
    );
  });

  it('accepts prompt text alone', () => {
    expect(resolveRemoteStartMissingContent({ hasPrompt: true, hasAttachments: false })).toBe(
      false
    );
  });

  it('accepts a file alone, exactly as the spawn payload builder does', () => {
    expect(resolveRemoteStartMissingContent({ hasPrompt: false, hasAttachments: true })).toBe(
      false
    );
  });

  it('accepts a prompt with a file', () => {
    expect(resolveRemoteStartMissingContent({ hasPrompt: true, hasAttachments: true })).toBe(false);
  });
});

describe('resolveContinueStartDisabled', () => {
  it('clone Cloud with no prompt and a loaded repo/model is enabled', () => {
    expect(resolveContinueStartDisabled(continueInput())).toBe(false);
  });

  it('clone Cloud with no repository is disabled', () => {
    expect(resolveContinueStartDisabled(continueInput({ selectedRepo: '' }))).toBe(true);
  });

  it('clone Cloud with a stale picker key (selected but unresolvable) is disabled', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ selectedRepo: 'github:owner/repo', selectedRepositoryResolved: false })
      )
    ).toBe(true);
  });

  it('clone Cloud with a resolved picker key stays enabled', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ selectedRepo: 'github:owner/repo', selectedRepositoryResolved: true })
      )
    ).toBe(false);
  });

  it('clone Cloud is disabled while creating or submitting', () => {
    expect(resolveContinueStartDisabled(continueInput({ isCreating: true }))).toBe(true);
    expect(resolveContinueStartDisabled(continueInput({ isSubmitting: true }))).toBe(true);
  });

  it('clone Cloud with no model is disabled', () => {
    expect(resolveContinueStartDisabled(continueInput({ model: '' }))).toBe(true);
  });

  it('clone CLI with no repository is enabled', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, selectedRepo: '' })
      )
    ).toBe(false);
  });

  it('clone CLI with an unavailable model is disabled', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, isModelUnavailable: true })
      )
    ).toBe(true);
  });

  it('clone CLI without sessionClone is disabled', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, instanceHasSessionClone: false })
      )
    ).toBe(true);
  });

  it('clone CLI is disabled while the instance catalog is loading', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, instanceCatalogLoading: true })
      )
    ).toBe(true);
  });

  it('clone CLI is disabled while spawning or submitting', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, isSpawningRemote: true })
      )
    ).toBe(true);
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, isSubmitting: true })
      )
    ).toBe(true);
  });

  it('clone CLI with a delivered clone/import failure is disabled until Run-on changes', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({
          isRemoteTargetSelected: true,
          cloneImportFailureKey: 'common.notFound',
        })
      )
    ).toBe(true);
  });

  it('clone CLI with no clone/import failure is not disabled by the failure field', () => {
    expect(
      resolveContinueStartDisabled(
        continueInput({ isRemoteTargetSelected: true, cloneImportFailureKey: null })
      )
    ).toBe(false);
  });
});

type NewSessionGateInput = Omit<
  Parameters<typeof resolveNewSessionStartDisabled>[0],
  'selectedRepo' | 'selectedRepositoryResolved'
>;

function newSessionGate(overrides: Partial<NewSessionGateInput> = {}): NewSessionGateInput {
  return {
    attachmentsHasFailed: false,
    attachmentsIsUploading: false,
    hasPrompt: true,
    isCreating: false,
    isRemoteTargetSelected: false,
    isSubmitting: false,
    model: 'claude-opus-4-7',
    profileGate: { kind: 'ready' },
    ...overrides,
  };
}

function continueGate(
  overrides: Partial<
    Omit<
      Parameters<typeof resolveContinueStartDisabled>[0],
      'selectedRepo' | 'selectedRepositoryResolved'
    >
  > = {}
) {
  return {
    isCreating: false,
    isSubmitting: false,
    isSpawningRemote: false,
    model: 'claude-opus-4-7',
    isRemoteTargetSelected: false,
    instanceCatalogLoading: false,
    instanceHasSessionClone: true,
    cloneImportFailureKey: null,
    isModelUnavailable: false,
    ...overrides,
  };
}

type ReasonInput = Parameters<typeof resolveNewSessionStartBlockedReason>[0];

function newSessionReasonInput(overrides: {
  hasRepositories?: boolean;
  hasConnectableProvider?: boolean;
  hasAttachments?: boolean;
  selectedRepositoryResolved?: boolean;
  isLoadingRepositories?: boolean;
  isRemoteTargetSelected?: boolean;
  selectedRepo?: string;
  gate?: ReturnType<typeof newSessionGate>;
}): ReasonInput {
  return {
    entry: 'new-session',
    hasRepositories: overrides.hasRepositories ?? true,
    hasConnectableProvider: overrides.hasConnectableProvider ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
    selectedRepositoryResolved: overrides.selectedRepositoryResolved ?? true,
    isLoadingRepositories: overrides.isLoadingRepositories ?? false,
    isRemoteTargetSelected: overrides.isRemoteTargetSelected ?? false,
    selectedRepo: overrides.selectedRepo ?? '',
    gate: overrides.gate ?? newSessionGate(),
  };
}

function continueReasonInput(overrides: {
  hasRepositories?: boolean;
  hasConnectableProvider?: boolean;
  hasAttachments?: boolean;
  selectedRepositoryResolved?: boolean;
  isLoadingRepositories?: boolean;
  isRemoteTargetSelected?: boolean;
  selectedRepo?: string;
  gate?: ReturnType<typeof continueGate>;
}): ReasonInput {
  return {
    entry: 'continue',
    hasRepositories: overrides.hasRepositories ?? true,
    hasConnectableProvider: overrides.hasConnectableProvider ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
    selectedRepositoryResolved: overrides.selectedRepositoryResolved ?? true,
    isLoadingRepositories: overrides.isLoadingRepositories ?? false,
    isRemoteTargetSelected: overrides.isRemoteTargetSelected ?? false,
    selectedRepo: overrides.selectedRepo ?? '',
    gate: overrides.gate ?? continueGate(),
  };
}

describe('resolveNewSessionConnectProvider', () => {
  it('picks the first connectable group in the section order', () => {
    expect(
      resolveNewSessionConnectProvider([
        { key: 'github', status: 'connect' },
        { key: 'gitlab', status: 'connect' },
        { key: 'bitbucket', status: 'connect' },
      ])
    ).toBe('github');
  });

  it('skips groups that are already connected, empty, loading, or failed', () => {
    expect(
      resolveNewSessionConnectProvider([
        { key: 'github', status: 'connected-empty' },
        { key: 'gitlab', status: 'loading' },
        { key: 'bitbucket', status: 'connect' },
      ])
    ).toBe('bitbucket');
    expect(
      resolveNewSessionConnectProvider([
        { key: 'github', status: 'error' },
        { key: 'gitlab', status: 'connect' },
      ])
    ).toBe('gitlab');
    expect(
      resolveNewSessionConnectProvider([
        { key: 'github', status: 'repos' },
        { key: 'gitlab', status: 'connect' },
      ])
    ).toBe('gitlab');
  });

  it('returns null when no provider is left to connect', () => {
    expect(
      resolveNewSessionConnectProvider([
        { key: 'github', status: 'repos' },
        { key: 'gitlab', status: 'connected-empty' },
      ])
    ).toBeNull();
    expect(resolveNewSessionConnectProvider([])).toBeNull();
  });
});

describe('resolveNewSessionStartBlockedReason', () => {
  it('returns select-repository when rows exist and none is selected', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: true, hasConnectableProvider: true })
      )
    ).toBe('select-repository');
  });

  it('returns refresh-repositories when there are no repositories and no connectable provider', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: false, hasConnectableProvider: false })
      )
    ).toBe('refresh-repositories');
  });

  it('returns connect-provider when there are no repositories and a connectable provider', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: false, hasConnectableProvider: true })
      )
    ).toBe('connect-provider');
  });

  it('never returns connect-provider while repository rows exist', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: true, hasConnectableProvider: true })
      )
    ).toBe('select-repository');
  });

  it('returns null when a repository is already selected', () => {
    expect(
      resolveNewSessionStartBlockedReason(newSessionReasonInput({ selectedRepo: 'org/repo' }))
    ).toBeNull();
  });

  it('returns null for a remote-CLI target that has content', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          isRemoteTargetSelected: true,
          gate: newSessionGate({ isRemoteTargetSelected: true }),
        })
      )
    ).toBeNull();
  });

  it('names the empty composer for a remote-CLI target with no prompt and no file', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          isRemoteTargetSelected: true,
          gate: newSessionGate({ isRemoteTargetSelected: true, hasPrompt: false }),
        })
      )
    ).toBe('enter-prompt-or-file');
  });

  it('keeps a remote-CLI reason silent once a file is attached without a prompt', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          isRemoteTargetSelected: true,
          hasAttachments: true,
          gate: newSessionGate({ isRemoteTargetSelected: true, hasPrompt: false }),
        })
      )
    ).toBeNull();
  });

  it('never names a repository or a prompt for a remote-CLI clone entry', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({
          isRemoteTargetSelected: true,
          gate: continueGate({ isRemoteTargetSelected: true }),
        })
      )
    ).toBeNull();
  });

  it('names the prompt for Cloud Agent when the repository is chosen and text is all that is left', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('enter-prompt');
  });

  it('names the prompt for Cloud Agent even with an attachment, which does not submit on its own', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          hasAttachments: true,
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('enter-prompt');
  });

  it('names the uploading attachment once the repository and prompt are set', () => {
    // The bug build's own state: the chip reads uploaded but the flag is still
    // true, so Start stays disabled with a prompt and a repository in place.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ attachmentsIsUploading: true }),
        })
      )
    ).toBe('attachment-uploading');
  });

  it('names the failed attachment, which outranks the upload flag it also sets', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ attachmentsHasFailed: true, attachmentsIsUploading: true }),
        })
      )
    ).toBe('attachment-failed');
  });

  it('names the still-loading profile once the repository and prompt are set', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ profileGate: { kind: 'loading' } }),
        })
      )
    ).toBe('profile-loading');
  });

  it('names the still-loading profile even while the prompt is also missing', () => {
    // Typing a prompt would not enable Start while the profile query is in
    // flight, so the prompt is not what the user has to wait for.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ hasPrompt: false, profileGate: { kind: 'loading' } }),
        })
      )
    ).toBe('profile-loading');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ hasPrompt: false, model: '' }),
        })
      )
    ).toBe('model-missing');
  });

  it('names the failed profile read for a pick once the repository and prompt are set', () => {
    // The pick cannot be confirmed while the read is in error, so Start waits
    // for the retry the Environment row and the footer both offer.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ profileGate: { kind: 'override-error' } }),
        })
      )
    ).toBe('profile-error');
  });

  it('names the failed profile read for a pick before any repository is chosen', () => {
    // With no repository selected the pick is still the blocker: re-evaluating
    // the gate against a synthetic repository stays disabled, so the missing
    // repository is not what the footer names.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          hasRepositories: true,
          gate: newSessionGate({ hasPrompt: false, profileGate: { kind: 'override-error' } }),
        })
      )
    ).toBe('profile-error');
  });

  it('stops naming the profile failure once a retried read resolves the pick', () => {
    // Recovery: the same picker, with the read settled, leaves the profile out
    // of the reason and names the one precondition still missing.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ hasPrompt: false, profileGate: { kind: 'ready' } }),
        })
      )
    ).toBe('enter-prompt');
  });

  it('names the stale selection instead of the prompt for a repository that no longer resolves', () => {
    // A stale picker key blocks Start on its own; the repository section asks
    // for a new pick, so naming the empty composer would hide the real blocker.
    // The stale selection is named whether or not the user has typed a prompt.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          selectedRepositoryResolved: false,
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('stale-selection');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          selectedRepositoryResolved: false,
          gate: newSessionGate({ hasPrompt: true }),
        })
      )
    ).toBe('stale-selection');
  });

  it('returns null while the repository list is still loading and no rows exist yet', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: false, isLoadingRepositories: true })
      )
    ).toBeNull();
  });

  it('names select-repository while a list is loading once rows already exist', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ hasRepositories: true, isLoadingRepositories: true })
      )
    ).toBe('select-repository');
  });

  it('names the repository/provider step on the initial empty form, before any prompt', () => {
    // The form opens with an empty composer, so the empty composer must not
    // hide the step the user can act on: without it Start is disabled with no
    // reason on screen.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          hasRepositories: false,
          hasConnectableProvider: true,
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('connect-provider');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          hasRepositories: false,
          hasConnectableProvider: false,
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('refresh-repositories');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          hasRepositories: true,
          hasConnectableProvider: true,
          gate: newSessionGate({ hasPrompt: false }),
        })
      )
    ).toBe('select-repository');
  });

  it('names a composer blocker before any repository is chosen, and stays silent for the rest', () => {
    // The repository step is not the cause here: each of these disables Start
    // with a repository supplied, so the footer names the wait or the fix.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ gate: newSessionGate({ profileGate: { kind: 'loading' } }) })
      )
    ).toBe('profile-loading');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          gate: newSessionGate({ hasPrompt: false, attachmentsIsUploading: true }),
        })
      )
    ).toBe('attachment-uploading');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          gate: newSessionGate({ hasPrompt: false, attachmentsHasFailed: true }),
        })
      )
    ).toBe('attachment-failed');
    // No copy can tell the user what to do about an in-flight create or submit,
    // so those stay unnamed; a missing model is named, because picking one is
    // the action the model row offers.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ gate: newSessionGate({ model: '' }) })
      )
    ).toBe('model-missing');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ gate: newSessionGate({ isSubmitting: true }) })
      )
    ).toBeNull();
  });

  it('names the loading profile ahead of a missing model', () => {
    // The profile settles on its own and the model the screen shows may arrive
    // with it, so the wait is named rather than the pick.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ profileGate: { kind: 'loading' }, model: '' }),
        })
      )
    ).toBe('profile-loading');
  });

  it('names the stale selection ahead of every composer blocker', () => {
    // The repository section is where the fix is, so the attachment wait and the
    // loading profile it also carries are not what the footer names.
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          selectedRepositoryResolved: false,
          gate: newSessionGate({ attachmentsIsUploading: true }),
        })
      )
    ).toBe('stale-selection');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          selectedRepositoryResolved: false,
          gate: newSessionGate({
            attachmentsIsUploading: true,
            profileGate: { kind: 'loading' },
          }),
        })
      )
    ).toBe('stale-selection');
  });

  it('names the missing model with a repository selected and a prompt typed, and before any repository', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({
          selectedRepo: 'org/repo',
          gate: newSessionGate({ model: '' }),
        })
      )
    ).toBe('model-missing');
    expect(
      resolveNewSessionStartBlockedReason(
        newSessionReasonInput({ gate: newSessionGate({ model: '' }) })
      )
    ).toBe('model-missing');
  });

  it('keeps the Continue clone entry silent for a stale selection', () => {
    // The clone entry has its own footer and its own gate, so it names nothing
    // here even though the gate itself stays disabled.
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({ selectedRepo: 'org/repo', selectedRepositoryResolved: false })
      )
    ).toBeNull();
  });

  it('names nothing and disables nothing when every precondition is satisfied', () => {
    // The reason and the gate read the same predicate, so a named reason and an
    // enabled Start can never disagree.
    const gate = newSessionGate();
    expect(
      resolveNewSessionStartBlockedReason(newSessionReasonInput({ selectedRepo: 'org/repo', gate }))
    ).toBeNull();
    expect(
      resolveNewSessionStartDisabled({
        ...gate,
        selectedRepo: 'org/repo',
        selectedRepositoryResolved: true,
      })
    ).toBe(false);
  });

  it('re-evaluates the Continue clone gate and names the connect step there too', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({ hasRepositories: false, hasConnectableProvider: true })
      )
    ).toBe('connect-provider');
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({ hasRepositories: true, hasConnectableProvider: false })
      )
    ).toBe('select-repository');
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({ hasRepositories: false, hasConnectableProvider: false })
      )
    ).toBe('refresh-repositories');
  });

  it('returns null for the Continue clone gate when another condition blocks it', () => {
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({ gate: continueGate({ model: '' }) })
      )
    ).toBeNull();
    expect(
      resolveNewSessionStartBlockedReason(
        continueReasonInput({
          isRemoteTargetSelected: true,
          gate: continueGate({ isRemoteTargetSelected: true }),
        })
      )
    ).toBeNull();
  });
});
