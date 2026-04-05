export class ArtifactReadError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause: cause });
    this.name = 'ArtifactReadError';
  }
}

export class EnvDecryptionError extends Error {
  public readonly key: string;

  constructor(message: string, key: string, cause: unknown) {
    super(message, { cause: cause });
    this.key = key;
    this.name = 'EnvDecryptionError';
  }
}

export class BuildStepError extends Error {
  public readonly script: string;

  constructor(message: string, script: string, cause?: unknown) {
    super(message, { cause });
    this.script = script;
    this.name = 'BuildStepError';
  }
}

export class GitCloneError extends Error {
  public readonly repoName: string;

  constructor(message: string, repoName: string, cause: unknown) {
    super(message, { cause });
    this.repoName = repoName;
    this.name = 'GitCloneError';
  }
}

export class GitLfsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'GitLfsError';
  }
}

export class ArchiveExtractionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ArchiveExtractionError';
  }
}

export class ProjectDetectionError extends Error {
  public readonly detectedType?: string;

  constructor(message: string, detectedType?: string, cause?: unknown) {
    super(message, { cause });
    this.detectedType = detectedType;
    this.name = 'ProjectDetectionError';
  }
}
