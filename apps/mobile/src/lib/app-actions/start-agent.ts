// The `StartAgent` action path: the same prepare the in-app create controls
// run, resolved end to end with no React tree, router, or screen, so an
// OS-surface run (Siri, Spotlight, Shortcuts, the Action button, Control
// Center, widget buttons) can start the session with the app closed.
//
// The shared core lives in `prepare-agent-session.ts`; this module resolves
// what only the action path has to resolve for itself —
// the target repository, the model, and the signed-in user's persisted
// safe-retry outbox. It never throws: every failure is a classified
// `AppActionResult` the caller reports back to the OS.

import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { i18n } from '@/i18n';
import { type AppActionResult, parseActionRepository } from '@/lib/app-actions/app-action-contract';
import {
  prepareAgentSession,
  type PrepareAgentSessionInput,
  type PrepareAgentSessionOutcome,
} from '@/lib/app-actions/prepare-agent-session';
import { type StartAgentRuntime } from '@/lib/app-actions/start-agent-runtime';
import { parseStoredModelPreference } from '@/lib/hooks/agent-model-preference';
import { pickAutoSelectedModel } from '@/lib/hooks/auto-select-model';

/** The mode the new-session form starts on when nothing else is stored. */
const DEFAULT_NEW_SESSION_MODE = normalizeAgentMode(undefined);

/** The `StartAgent` fields the OS surfaces hand to the action path. */
export type StartAgentInput = {
  prompt: string;
  /** A repository URL, git URL, or bare `owner/repo` the request names. */
  repository?: string;
  /** Set, the action continues that session instead of starting a new one. */
  sessionId?: string;
};

/** The terminal codes a `StartAgent` run can report. */
type StartAgentFailureCode =
  | 'empty-prompt'
  | 'unknown-repository'
  | 'unsupported-repository'
  | 'no-repository'
  | 'start-failed';

/**
 * Run one `StartAgent` intent: resolve the repository, the model, the
 * signed-in user's safe-retry outbox, and the session inputs, then prepare the
 * session through `prepareAgentSession`. Never throws; every failure is a
 * classified `AppActionResult`.
 */
export async function startAgent(input: StartAgentInput): Promise<AppActionResult> {
  const failedToCreate = i18n.t('agentChat.newSession.failedToCreate');
  try {
    const sessionId = nonBlank(input.sessionId);
    if (sessionId === null && input.prompt.trim().length === 0) {
      return startAgentFailure('empty-prompt', false, i18n.t('appActions.start.promptRequired'));
    }
    // Lazy: the in-app creators import this module, so the native half of the
    // action path must never enter their graph.
    const runtime = await import('@/lib/app-actions/start-agent-runtime');
    const repository = await resolveActionRepository(input.repository, runtime);
    if (!repository.ok) {
      return repository.result;
    }
    const selection = await resolveAutoModel(runtime);
    if (selection === null) {
      // No usable model: nothing about this intent can succeed on a retry.
      return startAgentFailure('start-failed', false, failedToCreate);
    }
    const userId = await runtime.currentUserId();
    if (userId === null) {
      return retryableStartFailure();
    }
    const outcome = await prepareAgentSession(
      sessionIntent(input, sessionId, { repository: repository.repository, ...selection }),
      {
        getKey: (fingerprint: string) => runtime.getKey(fingerprint),
        rotateKey: () => {
          runtime.rotateKey();
        },
        ...runtime.createOutbox(userId),
      }
    );
    if (outcome.ok) {
      return successResult(outcome);
    }
    if (outcome.reason === 'outbox-unreadable') {
      return retryableStartFailure();
    }
    return outcome.retryable
      ? retryableStartFailure()
      : startAgentFailure('start-failed', false, failedToCreate);
  } catch {
    // Any resolution failure (transport, storage, an unexpected throw) is a
    // start failure the user can retry.
    return retryableStartFailure();
  }
}

/** The resolved target one `StartAgent` intent runs against. */
type StartAgentTarget = {
  repository: NewSessionRepository;
  model: string;
  variant: string;
};

/** The intent to prepare: a new session, or the named session's clone. */
function sessionIntent(
  input: StartAgentInput,
  sessionId: string | null,
  target: StartAgentTarget
): PrepareAgentSessionInput {
  if (sessionId === null) {
    return {
      kind: 'new',
      prompt: input.prompt,
      repository: target.repository,
      mode: DEFAULT_NEW_SESSION_MODE,
      model: target.model,
      variant: target.variant,
      autoCommit: false,
    };
  }
  return {
    kind: 'continue',
    cloneFromKiloSessionId: sessionId,
    repository: target.repository,
    mode: DEFAULT_NEW_SESSION_MODE,
    model: target.model,
    variant: target.variant,
  };
}

/** The success result: the session id plus the route the surfaces open. */
function successResult(
  outcome: Extract<PrepareAgentSessionOutcome, { ok: true }>
): AppActionResult {
  return {
    ok: true,
    action: 'StartAgent',
    sessionId: outcome.sessionId,
    // `getAgentSessionPath` returns an `Href` (= `string | HrefObject`), but
    // every construction site in this codebase uses the string branch.
    href: getAgentSessionPath(outcome.sessionId) as string,
    // No catalog key names a started agent yet, and this slice adds none: the
    // result carries the id and the href the surfaces open.
    message: i18n.t('common.done'),
  };
}

/** A `start-failed` result the user can retry. */
function retryableStartFailure(): AppActionResult {
  return startAgentFailure('start-failed', true, i18n.t('agentChat.session.serviceUnavailable'));
}

/** A terminal `StartAgent` result: no session was created. */
function startAgentFailure(
  code: StartAgentFailureCode,
  retryable: boolean,
  message: string
): AppActionResult {
  return { ok: false, action: 'StartAgent', code, retryable, message };
}

/** One resolved repository, or the result to report instead. */
type ActionRepositoryResolution =
  | { ok: true; repository: NewSessionRepository }
  | { ok: false; result: AppActionResult };

/**
 * Resolve the repository a `StartAgent` request targets: the named one first,
 * otherwise the most recent session's repository. A named repository that
 * cannot be parsed, or a Bitbucket one (see `parseActionRepository`), fails
 * the run instead of silently starting somewhere else.
 */
async function resolveActionRepository(
  raw: string | undefined,
  runtime: StartAgentRuntime
): Promise<ActionRepositoryResolution> {
  const named = nonBlank(raw);
  const parsed =
    named === null ? await runtime.mostRecentRepository() : parseActionRepository(named);
  if (parsed === null) {
    return named === null
      ? { ok: false, result: noRepositoryFailure() }
      : {
          ok: false,
          result: startAgentFailure(
            'unknown-repository',
            false,
            i18n.t('appActions.start.repositoryUnknown', { repository: named })
          ),
        };
  }
  if (parsed.kind === 'unsupported') {
    return {
      ok: false,
      result: startAgentFailure(
        'unsupported-repository',
        false,
        i18n.t('appActions.start.repositoryUnsupported', { repository: parsed.fullName })
      ),
    };
  }
  return {
    ok: true,
    repository: { platform: parsed.kind, fullName: parsed.fullName, isPrivate: false },
  };
}

/** The empty state: no repository is named and none was used recently. */
function noRepositoryFailure(): AppActionResult {
  return startAgentFailure(
    'no-repository',
    false,
    i18n.t('agentChat.newSession.noRepositoriesVisible')
  );
}

/**
 * The model/variant the in-app form would preselect: the persisted preference
 * against the personal catalogue. Null when the catalogue is unusable, which
 * no retry can fix.
 */
async function resolveAutoModel(
  runtime: StartAgentRuntime
): Promise<{ model: string; variant: string } | null> {
  const [stored, models] = await Promise.all([
    runtime.storedModelPreferenceRaw(),
    runtime.modelCatalog(),
  ]);
  if (models === null) {
    return null;
  }
  return pickAutoSelectedModel({
    models,
    // The action path runs without the server preference query; the persisted
    // local preference is the same choice the picker restores first.
    lastSelected: null,
    stored: parseStoredModelPreference(stored),
    organizationId: undefined,
    orgDefaultModel: undefined,
    isDev: __DEV__,
  });
}

/** A non-blank string, trimmed, or null. */
function nonBlank(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
