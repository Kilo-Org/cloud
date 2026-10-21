/**
 * Pure boolean predicate for whether the "Start session" button on the
 * new-agent screen may submit right now. Lives in `lib/` (not next to
 * the route) so the regression test for the Wave 2 C3a slice can pin
 * both halves of the contract without rendering anything:
 *
 *   1. The existing cloud-agent path is byte-identical to before this
 *      slice landed — `canCreate` is computed with the exact same
 *      expression, and `isCloudAgentTargetSelected` defaults to `true`
 *      because the route's `runOnInstance` state defaults to `null`.
 *   2. Whenever a remote target is selected, this predicate evaluates to
 *      `false` REGARDLESS of the rest of the input: the remote-CLI spawn has
 *      its own gate (`resolveRemoteStartMissingContent` for the composer, plus
 *      the spawn flags the screen owns), because it needs neither a repository
 *      nor a Cloud Agent profile.
 */
export function resolveNewSessionSubmitEnabled({
  attachmentsHasFailed,
  attachmentsIsUploading,
  hasPrompt,
  isCreating,
  isRemoteTargetSelected,
  isSubmitting,
  model,
  selectedRepo,
}: {
  attachmentsHasFailed: boolean;
  attachmentsIsUploading: boolean;
  hasPrompt: boolean;
  isCreating: boolean;
  isRemoteTargetSelected: boolean;
  isSubmitting: boolean;
  model: string;
  selectedRepo: string;
}): boolean {
  // `attachmentsIsUploading` means "an upload is in flight". Attached-but-not-
  // uploaded chips no longer block Start: they upload during the create call.
  const canCreate =
    hasPrompt &&
    Boolean(selectedRepo) &&
    Boolean(model) &&
    !attachmentsIsUploading &&
    !attachmentsHasFailed;

  // The remote-target case short-circuits the entire cloud-agent
  // submission path, not just `canCreate`: no Cloud Agent create is ever
  // issued for a remote target. The screen gates the remote Start on the
  // spawn's own preconditions (see `resolveRemoteStartMissingContent`).
  if (isRemoteTargetSelected) {
    return false;
  }

  return canCreate && !isCreating && !isSubmitting;
}

/**
 * Inverse of `resolveNewSessionSubmitEnabled`, kept here so callers (and
 * tests) don't have to negate the condition at the call site.
 */
export function resolveNewSessionSubmitDisabled(input: {
  attachmentsHasFailed: boolean;
  attachmentsIsUploading: boolean;
  hasPrompt: boolean;
  isCreating: boolean;
  isRemoteTargetSelected: boolean;
  isSubmitting: boolean;
  model: string;
  selectedRepo: string;
}): boolean {
  return !resolveNewSessionSubmitEnabled(input);
}

/**
 * Whether the cloud-target "Start session" button is disabled, including the
 * effective-profile gate. A failed profile query is deliberately NOT a disable
 * reason: the form shows an inline error + Retry and Start stays enabled,
 * submitting with no effective profile id (the default is omitted). Only a
 * still-loading profile blocks Start, so an unsettled default is never
 * silently dropped.
 */
export function resolveNewSessionStartDisabled(input: {
  attachmentsHasFailed: boolean;
  attachmentsIsUploading: boolean;
  hasPrompt: boolean;
  isCreating: boolean;
  isRemoteTargetSelected: boolean;
  isSubmitting: boolean;
  model: string;
  selectedRepo: string;
  /** True when the selected repo key still resolves to a picker row. */
  selectedRepositoryResolved: boolean;
  isProfileLoading: boolean;
}): boolean {
  // A selected key that no longer resolves to a row (after a refresh or a
  // provider change) must not submit: the create body would carry no
  // repository field and the server would reject it.
  const staleSelection = input.selectedRepo !== '' && !input.selectedRepositoryResolved;
  return (
    staleSelection ||
    resolveNewSessionSubmitDisabled({
      attachmentsHasFailed: input.attachmentsHasFailed,
      attachmentsIsUploading: input.attachmentsIsUploading,
      hasPrompt: input.hasPrompt,
      isCreating: input.isCreating,
      isRemoteTargetSelected: input.isRemoteTargetSelected,
      isSubmitting: input.isSubmitting,
      model: input.model,
      selectedRepo: input.selectedRepo,
    }) ||
    input.isProfileLoading
  );
}

/**
 * Whether a remote-CLI start would hand the CLI nothing at all: no prompt text
 * and no attachment. Mirrors `buildComposerSharePayload`, which returns `null`
 * for exactly this composer state, so Start is blocked on the same condition
 * that makes the spawn carry no content.
 *
 * An attachment alone is enough. The destination session receives the files in
 * its composer (delivery does not auto-send without text, so the user sends
 * them there) while the spawn itself completes as usual.
 */
export function resolveRemoteStartMissingContent(input: {
  hasPrompt: boolean;
  hasAttachments: boolean;
}): boolean {
  return !input.hasPrompt && !input.hasAttachments;
}

/**
 * A synthetic, always-resolvable picker key used only to re-evaluate a Start
 * gate as if a repository were selected. It is never rendered or submitted.
 */
const SYNTHETIC_REPOSITORY_KEY = 'synthetic:selection';

/**
 * Why the Start button is unavailable, when the missing repository is what
 * blocks it. `select-repository` means a picker row exists to pick;
 * `connect-provider` means the account has no repositories at all and a
 * provider still has to be connected; `refresh-repositories` means the account
 * has no repositories but no provider is left to connect (a provider is
 * already connected and empty, or its list failed to load), so the way to get
 * rows is to refresh/check access — telling the user to select or connect
 * would name a control that does not exist.
 */
export type NewSessionStartBlockedReason =
  | 'select-repository'
  | 'connect-provider'
  | 'refresh-repositories'
  /** Cloud Agent needs prompt text; an attachment alone does not submit. */
  | 'enter-prompt'
  /** Remote CLI needs prompt text or a file; an empty composer spawns nothing. */
  | 'enter-prompt-or-file';

/**
 * The inputs for `resolveNewSessionStartBlockedReason`. `gate` is the entry's
 * own Start-gate input; `selectedRepo` / `selectedRepositoryResolved` are
 * omitted because the helper replaces them with a synthetic selection to tell
 * whether the missing repository is the one blocking Start.
 */
type NewSessionStartBlockedReasonInput = {
  /** The account has at least one repository row on some provider. */
  hasRepositories: boolean;
  /** A provider group the user can actually connect (`status === 'connect'`). */
  hasConnectableProvider: boolean;
  /** Any provider group is still loading, so its status is not settled. */
  isLoadingRepositories: boolean;
  /** True when a remote CLI is the run target rather than Cloud Agent. */
  isRemoteTargetSelected: boolean;
  /** The current picker key; `''` when no repository is selected. */
  selectedRepo: string;
  /**
   * The composer holds at least one attachment. A remote CLI receives files as
   * content, so a file alone unblocks its Start; Cloud Agent still needs text.
   */
  hasAttachments: boolean;
} & (
  | {
      entry: 'new-session';
      gate: Omit<
        Parameters<typeof resolveNewSessionStartDisabled>[0],
        'selectedRepo' | 'selectedRepositoryResolved'
      >;
    }
  | {
      entry: 'continue';
      gate: Omit<
        Parameters<typeof resolveContinueStartDisabled>[0],
        'selectedRepo' | 'selectedRepositoryResolved'
      >;
    }
);

/**
 * One line naming why Start is unavailable, or `null` when nothing nameable is
 * the blocker. Kept pure and beside the gates so both entries share the same
 * decision and the tests can pin it without rendering.
 *
 * A repository reason is only ever emitted when re-evaluating the entry's own
 * gate with a synthetic selected/resolved repository makes Start ENABLED — i.e.
 * the missing repository is the blocker. If the gate is still disabled with
 * that synthetic selection, some other precondition (empty prompt,
 * uploading/failed attachment, loading profile, creating/submitting, empty or
 * unavailable model) owns the blocker, and the repository is not it. Provider
 * connect state and repository count stay separate, exactly like the
 * extension's `submitBlockedReason` separates `integrationInstalled` from
 * `repoCount`: a `connected-empty`, `error`, or `repos` group never reads as
 * "connect a provider".
 *
 * Once every other precondition is satisfied, an empty composer is named
 * instead, because a disabled Start with no explanation is a dead end: Cloud
 * Agent needs prompt text, and a remote CLI needs a prompt or a file.
 */
export function resolveNewSessionStartBlockedReason(
  input: NewSessionStartBlockedReasonInput
): NewSessionStartBlockedReason | null {
  // A remote-CLI target inherits its repository from the CLI and never sends
  // one, so the missing repository is never its blocker. Its content is: an
  // empty composer hands the spawn nothing (`buildComposerSharePayload` returns
  // null for it). A clone entry has no composer at all.
  if (input.isRemoteTargetSelected) {
    if (input.entry !== 'new-session' || input.gate.hasPrompt || input.hasAttachments) {
      return null;
    }
    return 'enter-prompt-or-file';
  }
  // A selected repository means the picker was completed. When the empty
  // composer is all that still keeps Start disabled, name it: a prompt is the
  // one precondition Cloud Agent does not accept an attachment for.
  if (input.selectedRepo !== '') {
    if (
      input.entry === 'new-session' &&
      !input.gate.hasPrompt &&
      !resolveNewSessionStartDisabled({
        ...input.gate,
        hasPrompt: true,
        selectedRepo: input.selectedRepo,
        selectedRepositoryResolved: true,
      })
    ) {
      return 'enter-prompt';
    }
    return null;
  }
  // A still-loading list only defers the decision while it could change it: when
  // no rows exist yet, naming a blocker now could name the wrong one. Once rows
  // already exist, `select-repository` is unambiguous and must not be hidden
  // behind an unrelated group that is still loading.
  if (!input.hasRepositories && input.isLoadingRepositories) {
    return null;
  }

  const gateDisabledWithSyntheticRepo =
    input.entry === 'new-session'
      ? resolveNewSessionStartDisabled({
          ...input.gate,
          selectedRepo: SYNTHETIC_REPOSITORY_KEY,
          selectedRepositoryResolved: true,
        })
      : resolveContinueStartDisabled({
          ...input.gate,
          selectedRepo: SYNTHETIC_REPOSITORY_KEY,
          selectedRepositoryResolved: true,
        });

  // Still disabled with a repository supplied: some other condition blocks
  // Start, so the missing repository is not the reason.
  if (gateDisabledWithSyntheticRepo) {
    return null;
  }

  // The account cannot pick a repository yet and a provider can still be
  // connected: name the connect step rather than an empty picker.
  if (!input.hasRepositories && input.hasConnectableProvider) {
    return 'connect-provider';
  }
  // No repositories and no provider left to connect (already connected but
  // empty, or its list failed): the picker is empty and disabled, so neither
  // "select" nor "connect" names a control the user can reach. Name the
  // refresh/access step the repository section actually offers instead.
  if (!input.hasRepositories) {
    return 'refresh-repositories';
  }
  return 'select-repository';
}

/**
 * Whether the continue-form Start button is disabled. Distinct from the
 * ordinary new-session gate: a clone carries no prompt and no profile
 * requirement.
 *
 *   - Clone Cloud Agent: disabled while creating, submitting, without a model,
 *     or without a repository. Empty prompt and profile loading do NOT block.
 *   - Clone live CLI: disabled while spawning, submitting, without a model,
 *     while the instance catalog is loading, when the instance lacks the
 *     `sessionClone` capability, or while a delivered clone/import failure is
 *     shown inline. Empty prompt, empty repository, and profile loading do NOT
 *     block.
 */
export function resolveContinueStartDisabled(input: {
  isCreating: boolean;
  isSubmitting: boolean;
  isSpawningRemote: boolean;
  model: string;
  selectedRepo: string;
  selectedRepositoryResolved: boolean;
  isRemoteTargetSelected: boolean;
  instanceCatalogLoading: boolean;
  instanceHasSessionClone: boolean;
  cloneImportFailureKey: string | null;
  isModelUnavailable: boolean;
}): boolean {
  if (input.isRemoteTargetSelected) {
    return (
      input.isSpawningRemote ||
      input.isSubmitting ||
      input.model === '' ||
      input.isModelUnavailable ||
      input.instanceCatalogLoading ||
      !input.instanceHasSessionClone ||
      input.cloneImportFailureKey !== null
    );
  }
  // A selected picker key that no longer resolves to a row must not submit:
  // the clone prepare body would carry no repository field and the server
  // would reject it. Mirrors `resolveNewSessionStartDisabled`'s stale gate.
  const staleSelection = input.selectedRepo !== '' && !input.selectedRepositoryResolved;
  return (
    input.isCreating ||
    input.isSubmitting ||
    input.model === '' ||
    input.selectedRepo === '' ||
    staleSelection
  );
}
