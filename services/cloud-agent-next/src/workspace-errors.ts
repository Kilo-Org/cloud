export type WorkspaceFilesystemPreparationTarget = 'workspace_directory' | 'session_home';

export class WorkspaceFilesystemPreparationError extends Error {
  target: WorkspaceFilesystemPreparationTarget;

  constructor(target: WorkspaceFilesystemPreparationTarget, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceFilesystemPreparationError';
    this.target = target;
  }
}

export type WorkspaceCapacityAdmissionRejectionDetails = {
  availableMB: number;
  thresholdMB: number;
  cleaned: number;
  skipped: number;
};

export class WorkspaceCapacityAdmissionRejectedError extends Error {
  readonly availableMB: number;
  readonly thresholdMB: number;
  readonly cleaned: number;
  readonly skipped: number;

  constructor(details: WorkspaceCapacityAdmissionRejectionDetails) {
    super(
      `Workspace admission rejected: ${details.availableMB} MB available below ${details.thresholdMB} MB threshold after cleanup`
    );
    this.name = 'WorkspaceCapacityAdmissionRejectedError';
    this.availableMB = details.availableMB;
    this.thresholdMB = details.thresholdMB;
    this.cleaned = details.cleaned;
    this.skipped = details.skipped;
  }
}

export class WorkspaceCapacityInspectionUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceCapacityInspectionUnavailableError';
  }
}

export function isSandboxFilesystemUnusableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOSPC\b|no space left on device/i.test(message);
}

export class SandboxCapacityInspectionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SandboxCapacityInspectionError';
  }
}
