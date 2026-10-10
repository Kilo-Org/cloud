export type EnvironmentIdentityInput =
  | { platform: 'github'; fullName: string }
  | { platform: 'gitlab'; projectPath: string }
  | { platform: 'bitbucket'; workspaceUuid: string; repositoryUuid: string };

export function environmentIdentityKey(repository: EnvironmentIdentityInput): string {
  switch (repository.platform) {
    case 'github':
      return `github:${repository.fullName.trim().toLowerCase()}`;
    case 'gitlab':
      return `gitlab:${repository.projectPath}`;
    case 'bitbucket':
      return `bitbucket:${repository.workspaceUuid.toLowerCase()}:${repository.repositoryUuid.toLowerCase()}`;
  }
}

export type EnvironmentListStatus = 'loading' | 'error' | 'success';

export type EnvironmentSelectionState = {
  id: string | null;
  identity: string | null;
};

/**
 * The identity the current selection belongs to. The caller threads this
 * through so a selection is dropped when the repository, platform, or owner
 * changes, and when a successful list no longer contains it. Loading and error
 * results keep the selection, so a background failure never blanks it.
 */
export function resolveEnvironmentSelection(
  previous: EnvironmentSelectionState,
  input: {
    identity: string | null;
    environments: readonly { id: string }[] | undefined;
    status: EnvironmentListStatus;
  }
): EnvironmentSelectionState {
  if (!input.identity) return { id: null, identity: null };
  if (input.identity !== previous.identity) return { id: null, identity: input.identity };
  if (input.status !== 'success' || !input.environments) return previous;
  if (previous.id && !input.environments.some(environment => environment.id === previous.id)) {
    return { id: null, identity: input.identity };
  }
  return previous;
}
