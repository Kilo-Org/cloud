// The React-free core of the two in-app create controls: the new-session form
// (`useNewSessionCreator`) and the Continue clone (`useContinueCloudCreate`).
//
// It owns the retry fingerprint, the hoisted/persisted operation key, the
// safe-retry row written before the mutate, the `prepareSession` call, and the
// key/row cleanup on settle. The callers keep every UI concern (spinner,
// toasts, haptics, navigation) and hand in their hook-owned pieces.
//
// `start-agent.ts` reuses the same core for the OS-surface action path, so a
// session an action starts is the same session the form would start.

import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';

import { type AgentMode } from '@/components/agents/mode-normalize';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import {
  getSelectedBranchOverride,
  type NewSessionRepository,
} from '@/components/agents/new-session-repository-state';
import {
  type PrepareSessionRepositoryFields,
  resolveRepoFingerprint,
  setRepositoryField,
} from '@/components/agents/prepare-session-repository';
import { i18n } from '@/i18n';
import { type AgentAttachmentWire } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { trpcClient } from '@/lib/trpc';

/**
 * One intent to prepare: the new-session form's draft, or the Continue
 * control's clone. `organizationId` scopes the create to the screen's
 * organization; the action path never carries one.
 */
export type PrepareAgentSessionInput =
  | {
      kind: 'new';
      prompt: string;
      /** Omitted, a fresh message id is generated for the create body. */
      initialMessageId?: string;
      repository?: NewSessionRepository | null;
      mode: AgentMode;
      model: string;
      variant?: string;
      profileId?: string | null;
      /** Manual env vars layered over the profile; omitted from the body when empty. */
      envVars?: Record<string, string>;
      /** Manual setup commands layered over the profile; omitted from the body when empty. */
      setupCommands?: string[];
      /** Commit and push the agent's changes (true) or leave them uncommitted. */
      autoCommit?: boolean;
      attachments?: AgentAttachmentWire;
      organizationId?: string;
    }
  | {
      kind: 'continue';
      cloneFromKiloSessionId: string;
      repository?: NewSessionRepository | null;
      mode: AgentMode;
      model: string;
      variant?: string;
      organizationId?: string;
    };

/** A safe-retry row, matching `OutboxRowInput` in `use-mutation-outbox`. */
type SafeRetryRowInput = {
  operationKey: string;
  fingerprint: string;
  input: unknown;
};

/** The caller-owned pieces `prepareAgentSession` needs. */
export type PrepareAgentSessionDeps = {
  /** One key per submit intent; the in-app creators hoist it, the action path mints it. */
  getKey: (fingerprint: string) => string;
  /** Ends the current intent so the next submit mints a fresh key. */
  rotateKey: () => void;
  getStoredOperationKey: (fingerprint: string) => string | null;
  writeSafeRetry: (row: SafeRetryRowInput) => Promise<void>;
  removeOutboxRow: (fingerprint: string) => Promise<void>;
  /**
   * Resolves after the launch load settled. `false` means the stored rows
   * could not be read, and the intent must refuse rather than mint a key over
   * a row whose POST the server may already have accepted.
   */
  whenLoaded: () => Promise<boolean>;
  /** Post-success cache invalidation; the in-app callers own their query client. */
  invalidate?: () => Promise<void>;
};

/**
 * What a prepare did. `outbox-unreadable` is its own reason (not a prepare
 * rejection) because the callers' failure feedback differs: the in-app form
 * toasts its own "could not read pending sessions" and never offers the
 * server's message, while the action path reports a retryable start failure.
 */
export type PrepareAgentSessionOutcome =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      reason: 'outbox-unreadable' | 'prepare-failed';
      retryable: boolean;
      message: string;
      /**
       * The prepare rejection, when it was an `Error`. A caller that
       * classifies rejections itself (the Continue route) rethrows it, so its
       * retryable/terminal split and copy stay what they were before the
       * shared core owned the call.
       */
      error?: Error;
    };

/**
 * Prepare one session: reuse or mint the intent's `operationKey`, persist the
 * safe-retry row before the mutate, and settle the key and the row on the
 * result. Never throws — a rejection is classified with
 * `isCloudPrepareRetryableError` and returned.
 */
export async function prepareAgentSession(
  input: PrepareAgentSessionInput,
  deps: PrepareAgentSessionDeps
): Promise<PrepareAgentSessionOutcome> {
  const fingerprint = intentFingerprint(input);
  // Gate on the outbox load first: a prepare that races the launch load would
  // read empty rows and mint a duplicate. A failed read reads as no stored
  // rows, so refuse instead of minting a fresh key over a row whose POST the
  // server may already have accepted.
  if (!(await deps.whenLoaded())) {
    return {
      ok: false,
      reason: 'outbox-unreadable',
      retryable: false,
      message: i18n.t('agentChat.newSession.couldNotReadPendingSessions'),
    };
  }
  // Reuse a stored safe-retry key for this fingerprint on relaunch; mint a
  // fresh key only when no stored row exists. A stored row must never be
  // replaced by a new in-memory key.
  let operationKey = deps.getStoredOperationKey(fingerprint);
  // Pre-fix safe-retry rows persisted the bare `fullName` as `repo`. A GitHub
  // `owner/repo` is inherently a single-provider identity, so only GitHub
  // intents fall back to the legacy bare-name lookup: two same-named
  // GitLab/Bitbucket rows must never share the stale retry key.
  let legacyRowToDrop: string | null = null;
  if (input.kind === 'new') {
    const legacyFingerprint = legacyIntentFingerprint(input);
    if (operationKey === null && legacyFingerprint !== null) {
      operationKey = deps.getStoredOperationKey(legacyFingerprint);
      if (operationKey !== null) {
        legacyRowToDrop = legacyFingerprint;
      }
    }
  }
  operationKey ??= deps.getKey(fingerprint);

  const body = prepareSessionBody(input, operationKey);
  try {
    // Persist the safe-retry row BEFORE the mutate so a crash mid-flight
    // reuses the same key on relaunch instead of minting a duplicate. The
    // consumed legacy row migrates to the scoped fingerprint only after the
    // scoped row exists: a crash between the two writes would otherwise lose
    // the key and mint a duplicate session on relaunch.
    await deps.writeSafeRetry({ operationKey, fingerprint, input: body });
    if (legacyRowToDrop !== null) {
      await deps.removeOutboxRow(legacyRowToDrop);
    }

    const result = input.organizationId
      ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
          ...body,
          organizationId: input.organizationId,
        })
      : await trpcClient.cloudAgentNext.prepareSession.mutate(body);

    // Rotate before the post-success work so a UI failure cannot keep the
    // successful key for a retry.
    deps.rotateKey();
    await deps.removeOutboxRow(fingerprint);

    // The cloud session already exists, so a post-success invalidation failure
    // is cosmetic and must not report the create as failed or invite a
    // duplicate retry.
    try {
      await deps.invalidate?.();
    } catch {
      // Cosmetic; the caller still signals success.
    }
    return { ok: true, sessionId: result.kiloSessionId };
  } catch (error) {
    const retryable = isCloudPrepareRetryableError(error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : i18n.t('agentChat.newSession.failedToCreate');
    // A typed terminal rejection ends the intent; a retryable one keeps the key.
    if (!retryable) {
      deps.rotateKey();
      await deps.removeOutboxRow(fingerprint);
    }
    return {
      ok: false,
      reason: 'prepare-failed',
      retryable,
      message,
      ...(error instanceof Error ? { error } : {}),
    };
  }
}

/**
 * The `prepareSession` body fields both variants share. The repository fields
 * come from the shared module, so exactly one of them matches the selected row
 * and the schema refines that; the create path may add `upstreamBranch`.
 */
type PrepareSessionSharedFields = PrepareSessionRepositoryFields & {
  mode: AgentMode;
  model: string;
  variant: string | undefined;
  autoCommit: boolean;
  autoInitiate: true;
  operationKey: string;
  upstreamBranch?: string;
  profileId?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  attachments?: AgentAttachmentWire;
};

/**
 * The `prepareSession` body. The schema's clone variant forbids `prompt` and
 * `initialMessageId` (`z.undefined()`), so the two intents are a discriminated
 * union here too — a loose optional `prompt` would not be assignable.
 */
type PrepareSessionBody =
  | (PrepareSessionSharedFields & { prompt: string; initialMessageId: string })
  | (PrepareSessionSharedFields & { cloneFromKiloSessionId: string });

/**
 * The retry fingerprint of an intent. Kept byte-identical to the shape the
 * deployed app persisted, so a relaunch reuses an existing safe-retry row
 * instead of minting a duplicate session.
 */
function intentFingerprint(input: PrepareAgentSessionInput): string {
  if (input.kind === 'continue') {
    return JSON.stringify({
      cloneFromKiloSessionId: input.cloneFromKiloSessionId,
      repo: resolveRepoFingerprint(input.repository ?? null),
      model: input.model,
      variant: variantOrUndefined(input.variant),
      mode: input.mode,
      organizationId: input.organizationId ?? null,
    });
  }
  return newIntentFingerprint(input, resolveRepoFingerprint(input.repository ?? null));
}

/**
 * The pre-fix fingerprint of a new-session intent, which stored the bare
 * `fullName` as `repo`. Only GitHub intents have a legacy form; a GitLab or
 * Bitbucket intent never looks one up.
 */
function legacyIntentFingerprint(
  input: Extract<PrepareAgentSessionInput, { kind: 'new' }>
): string | null {
  const repository = input.repository ?? null;
  if (repository?.platform !== 'github') {
    return null;
  }
  return newIntentFingerprint(input, repository.fullName);
}

/** The stored shape of a new-session fingerprint, with the given repo identity. */
function newIntentFingerprint(
  input: Extract<PrepareAgentSessionInput, { kind: 'new' }>,
  repo: ReturnType<typeof resolveRepoFingerprint> | string
): string {
  // The inline overrides are part of the intent only when present, so a session
  // with no manual config keeps the exact fingerprint the deployed app stored
  // (a relaunch reuses its safe-retry key instead of minting a duplicate).
  const inlineOverrides =
    input.envVars !== undefined && Object.keys(input.envVars).length > 0
      ? { envVars: input.envVars }
      : {};
  const setupCommands =
    input.setupCommands !== undefined && input.setupCommands.length > 0
      ? { setupCommands: input.setupCommands }
      : {};
  return JSON.stringify({
    prompt: input.prompt,
    mode: input.mode,
    model: input.model,
    variant: variantOrUndefined(input.variant),
    repo,
    autoCommit: input.autoCommit ?? false,
    organizationId: input.organizationId ?? null,
    profileId: input.profileId ?? null,
    attachments: input.attachments ?? null,
    ...inlineOverrides,
    ...setupCommands,
  });
}

/** The model's selected effort, or undefined when the model has no variants. */
function variantOrUndefined(variant: string | undefined): string | undefined {
  if (variant === undefined || variant.length === 0) {
    return undefined;
  }
  return variant;
}

/** Assemble the create body for one intent. */
function prepareSessionBody(
  input: PrepareAgentSessionInput,
  operationKey: string
): PrepareSessionBody {
  if (input.kind === 'continue') {
    // The clone-only prepare schema forbids `prompt` and `initialMessageId`;
    // the clone carries no synthetic turn.
    const body: PrepareSessionBody = {
      mode: input.mode,
      model: input.model,
      variant: variantOrUndefined(input.variant),
      autoCommit: false,
      autoInitiate: true,
      operationKey,
      cloneFromKiloSessionId: input.cloneFromKiloSessionId,
    };
    // The clone variant has no branch: the Continue control clones a session,
    // not a checkout, so no `upstreamBranch` is written.
    setRepositoryField(body, input.repository ?? null);
    return body;
  }
  const body: PrepareSessionBody = {
    prompt: input.prompt,
    initialMessageId: input.initialMessageId ?? generateMessageId(),
    mode: input.mode,
    model: input.model,
    variant: variantOrUndefined(input.variant),
    autoCommit: input.autoCommit ?? false,
    autoInitiate: true,
    operationKey,
  };
  // Carry the branch only when the shared writer actually wrote a repository
  // field, so a Bitbucket row missing its uuids sends neither field nor branch.
  if (setRepositoryField(body, input.repository ?? null)) {
    setUpstreamBranch(body, input.repository ?? null);
  }
  if (input.profileId) {
    body.profileId = input.profileId;
  }
  // Inline overrides the server layers over the resolved profile. Omitted when
  // empty so the body is byte-identical to what the deployed app sent before
  // the advanced config carried manual values.
  if (input.envVars !== undefined && Object.keys(input.envVars).length > 0) {
    body.envVars = input.envVars;
  }
  if (input.setupCommands !== undefined && input.setupCommands.length > 0) {
    body.setupCommands = input.setupCommands;
  }
  if (input.attachments) {
    body.attachments = input.attachments;
  }
  return body;
}

/**
 * Carry the branch only when a repository field was written for it. The clone
 * variant has no branch: the Continue control clones a session, not a
 * checkout. Deliberately absent from the retry fingerprint: the retry key
 * stays repository-scoped, and changing the branch must not fork it.
 */
function setUpstreamBranch(
  body: PrepareSessionSharedFields,
  repository: NewSessionRepository | null
): void {
  if (repository === null) {
    return;
  }
  const branch = getSelectedBranchOverride(repository);
  if (branch !== null) {
    body.upstreamBranch = branch;
  }
}
