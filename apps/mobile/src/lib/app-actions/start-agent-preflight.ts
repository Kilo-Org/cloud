// What a `StartAgent` request has to satisfy before the app asks the user to
// approve it, decided from the request alone.
//
// Pure: the contract, the catalog, and nothing else. Both the dispatcher, which
// asks the question, and `start-agent.ts`, which runs the request, call this, so
// a request that cannot start is classified the same way on both paths and the
// user is not asked to approve a run that cannot happen.

import { i18n } from '@/i18n';

import {
  type AppActionResult,
  parseActionRepository,
  type ParsedActionRepository,
} from './app-action-contract';

/** A repository a request names, or the reason the request cannot run. */
export type StartAgentPreflight =
  | { ok: true; named: ParsedActionRepository | null }
  | { ok: false; result: AppActionResult };

/** A non-blank string, trimmed, or null. */
function nonBlank(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A terminal `StartAgent` result: no session was created. */
function startAgentFailure(
  code: 'empty-prompt' | 'no-repository' | 'unknown-repository' | 'unsupported-repository',
  message: string
): AppActionResult {
  return { ok: false, action: 'StartAgent', code, retryable: false, message };
}

/** The empty state: no repository is named and none was used recently. */
export function noRepositoryFailure(): AppActionResult {
  return startAgentFailure('no-repository', i18n.t('appActions.start.repositoryRequired'));
}

/** A repository whose provider the create call cannot address from here. */
export function unsupportedRepositoryFailure(fullName: string): AppActionResult {
  return startAgentFailure(
    'unsupported-repository',
    i18n.t('appActions.start.repositoryUnsupported', { repository: fullName })
  );
}

/**
 * Classify the request: the prompt, then a named repository.
 *
 * A request that names no repository passes here even when none is available:
 * only the running app knows the recent repository it would fall back to, and
 * the request has to reach `start-agent.ts` for that lookup. A named repository
 * is pure to check, so a name the create call cannot use is refused before the
 * question instead of after it.
 */
export function preflightStartAgent(input: {
  prompt: string;
  sessionId?: string | undefined;
  repository?: string | undefined;
}): StartAgentPreflight {
  // A session start continues the session it names; only one that names neither
  // has nothing to run.
  if (nonBlank(input.prompt) === null && nonBlank(input.sessionId) === null) {
    return {
      ok: false,
      result: startAgentFailure('empty-prompt', i18n.t('appActions.start.promptRequired')),
    };
  }
  const named = nonBlank(input.repository);
  if (named === null) {
    return { ok: true, named: null };
  }
  const parsed = parseActionRepository(named);
  if (parsed === null) {
    return {
      ok: false,
      result: startAgentFailure(
        'unknown-repository',
        i18n.t('appActions.start.repositoryUnknown', { repository: named })
      ),
    };
  }
  if (parsed.kind === 'unsupported') {
    return { ok: false, result: unsupportedRepositoryFailure(parsed.fullName) };
  }
  return { ok: true, named: parsed };
}
