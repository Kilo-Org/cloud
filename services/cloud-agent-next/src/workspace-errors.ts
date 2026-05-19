export type WorkspaceFilesystemPreparationTarget = 'workspace_directory' | 'session_home';

export class WorkspaceFilesystemPreparationError extends Error {
  target: WorkspaceFilesystemPreparationTarget;

  constructor(target: WorkspaceFilesystemPreparationTarget, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceFilesystemPreparationError';
    this.target = target;
  }
}
