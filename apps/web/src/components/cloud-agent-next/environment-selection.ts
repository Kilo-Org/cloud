import {
  environmentMembers,
  type EnvironmentMemberResponse,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
import { memberMatchesRepository } from './environment-display';

/**
 * Which environment a new session in the selected repository uses. One match
 * needs no choice. Several matches need the user to choose, and the server fails
 * a start that does not name one.
 */
export type EnvironmentSelection =
  | { status: 'loading' }
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'selected'; environment: EnvironmentSummary; chosen: boolean }
  | { status: 'choose'; environments: EnvironmentSummary[] };

/**
 * `matches` is the repository's environments. It is undefined while they load
 * (`isLoading`) and when the load failed or no repository is selected.
 */
export function selectEnvironment(
  matches: readonly EnvironmentSummary[] | undefined,
  chosenId: string | null,
  isLoading: boolean
): EnvironmentSelection {
  if (matches === undefined) return { status: isLoading ? 'loading' : 'unknown' };
  const [only, ...others] = matches;
  if (only === undefined) return { status: 'none' };
  if (others.length === 0) return { status: 'selected', environment: only, chosen: false };
  const chosen = matches.find(environment => environment.id === chosenId);
  return chosen
    ? { status: 'selected', environment: chosen, chosen: true }
    : { status: 'choose', environments: [...matches] };
}

/** The environment the session uses, or undefined while unknown or not yet chosen. */
export function selectedEnvironment(
  selection: EnvironmentSelection
): EnvironmentSummary | null | undefined {
  switch (selection.status) {
    case 'none':
      return null;
    case 'selected':
      return selection.environment;
    case 'loading':
    case 'unknown':
    case 'choose':
      return undefined;
  }
}

/**
 * Whether the start must wait. A start sent while the matches load could meet
 * several environments with no choice. A failed load does not block: the server
 * then decides, so a list error cannot stop every start.
 */
export function environmentBlocksStart(selection: EnvironmentSelection): boolean {
  return selection.status === 'loading' || selection.status === 'choose';
}

/** Whether the environment is multi-repository (V2). */
export function isMultiRepositoryEnvironment(environment: EnvironmentSummary): boolean {
  return environment.repositories !== undefined;
}

/**
 * The repositories a V2 session clones beside the launch repository. A V1
 * environment has none.
 */
export function additionalRepositories(
  environment: EnvironmentSummary,
  launch: EnvironmentRepository
): EnvironmentMemberResponse[] {
  if (!isMultiRepositoryEnvironment(environment)) return [];
  return environmentMembers(environment).filter(member => !memberMatchesRepository(member, launch));
}

/** Branch inputs by lowercased `repoFullName`. An empty input means no branch. */
export type AdditionalBranches = Readonly<Record<string, string>>;

export function branchKey(member: Pick<EnvironmentMemberResponse, 'repoFullName'>): string {
  return member.repoFullName.toLowerCase();
}

/**
 * The `requestedEnvironment` of the create request. It names the environment
 * only when the user chose it or named a branch for an additional repository;
 * otherwise the server resolves the single match itself.
 */
export function buildRequestedEnvironment(
  selection: EnvironmentSelection,
  launch: EnvironmentRepository,
  branches: AdditionalBranches
): { id: string; repositories?: { repoFullName: string; branch: string }[] } | undefined {
  if (selection.status !== 'selected') return undefined;
  const { environment, chosen } = selection;
  const repositories = additionalRepositories(environment, launch).flatMap(member => {
    const branch = branches[branchKey(member)]?.trim();
    return branch ? [{ repoFullName: member.repoFullName, branch }] : [];
  });
  if (repositories.length > 0) return { id: environment.id, repositories };
  return chosen ? { id: environment.id } : undefined;
}
