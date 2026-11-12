// Which cloud environment a new session in the selected repository uses. This
// mirrors `environment-selection.ts` and `useSessionEnvironment` on the web, so
// the same repository keeps producing the same pick: one match needs no choice,
// several need one, and the server fails a start that names none.
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';

/** One row of `cloudEnvironments.list`, scoped to the selected repository. */
export type EnvironmentSummaryRow =
  inferRouterOutputs<MobileRouter>['cloudEnvironments']['list'][number];

/** The repository identity `cloudEnvironments.list` compares against. */
export type EnvironmentRepositoryInput =
  | { platform: 'github'; fullName: string }
  | { platform: 'gitlab'; projectPath: string }
  | { platform: 'bitbucket'; workspaceUuid: string; repositoryUuid: string };

/**
 * The repository field of `cloudEnvironments.list`. A Bitbucket row without its
 * uuid pair cannot name a repository, so it lists nothing rather than every
 * environment of the account.
 */
export function toEnvironmentRepositoryInput(
  repository: NewSessionRepository | null
): EnvironmentRepositoryInput | null {
  if (repository === null) {
    return null;
  }
  if (repository.platform === 'github') {
    return { platform: 'github', fullName: repository.fullName };
  }
  if (repository.platform === 'gitlab') {
    return { platform: 'gitlab', projectPath: repository.fullName };
  }
  return repository.workspaceUuid && repository.repositoryUuid
    ? {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      }
    : null;
}

/**
 * The identity the last environment choice is remembered under: one record per
 * repository and personal/organization scope, like the web's stored key.
 */
export function environmentChoiceKey(
  organizationId: string | undefined,
  repository: NewSessionRepository
): string {
  const scope = organizationId ?? 'personal';
  if (repository.platform === 'bitbucket') {
    return `${scope}|bitbucket|${(repository.workspaceUuid ?? '').toLowerCase()}:${(
      repository.repositoryUuid ?? ''
    ).toLowerCase()}`;
  }
  return `${scope}|${repository.platform}|${repository.fullName.toLowerCase()}`;
}

/** How many repositories an environment clones; a V1 environment has one. */
export function environmentRepositoryCount(environment: EnvironmentSummaryRow): number {
  return 'repositories' in environment ? environment.repositories.length : 1;
}

/**
 * The environment decision for one repository. `idle` is a form with no
 * repository yet, which asks the server nothing.
 */
export type EnvironmentSelection =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'selected'; environment: EnvironmentSummaryRow; chosen: boolean }
  | { status: 'choose'; environments: EnvironmentSummaryRow[] };

/**
 * `matches` is the repository's environments. It is undefined while they load
 * (`isLoading`) and when the load failed or no repository is selected.
 */
export function selectEnvironment(
  matches: readonly EnvironmentSummaryRow[] | undefined,
  chosenId: string | null,
  isLoading: boolean
): EnvironmentSelection {
  if (matches === undefined) {
    return { status: isLoading ? 'loading' : 'unknown' };
  }
  const [only, ...others] = matches;
  if (only === undefined) {
    return { status: 'none' };
  }
  if (others.length === 0) {
    return { status: 'selected', environment: only, chosen: false };
  }
  const chosen = matches.find(environment => environment.id === chosenId);
  return chosen
    ? { status: 'selected', environment: chosen, chosen: true }
    : { status: 'choose', environments: [...matches] };
}

/** The environment the session uses, or undefined while unknown or not yet chosen. */
export function selectedEnvironment(
  selection: EnvironmentSelection
): EnvironmentSummaryRow | null | undefined {
  if (selection.status === 'none') {
    return null;
  }
  return selection.status === 'selected' ? selection.environment : undefined;
}

/**
 * Whether the start must wait. A start sent while the matches load could meet
 * several environments with no choice. A failed load does not block: the server
 * then decides, so a list error cannot stop every start.
 */
export function environmentBlocksStart(selection: EnvironmentSelection): boolean {
  return selection.status === 'loading' || selection.status === 'choose';
}

/**
 * The `requestedEnvironment` of the create request. It names the environment
 * only when the person chose it; a single match is resolved by the server, so
 * the body stays identical to the one the deployed app sent.
 */
export function requestedEnvironmentForSelection(
  selection: EnvironmentSelection
): { id: string } | undefined {
  return selection.status === 'selected' && selection.chosen
    ? { id: selection.environment.id }
    : undefined;
}

/**
 * Whether the form must tell the server that a picker exists. Without it the
 * server runs a repository with several environments and no choice with none of
 * them; with it the start fails and names them, which is the web's contract.
 */
export function requiresEnvironmentChoice(selection: EnvironmentSelection): boolean {
  return selection.status !== 'idle' && selection.status !== 'unknown';
}
