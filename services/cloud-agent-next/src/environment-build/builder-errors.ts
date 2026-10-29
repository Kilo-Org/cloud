/** A provider operation whose outcome is unknown; the coordinator retries it. */
export class BuilderRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BuilderRetryableError';
  }
}

/** The pinned account no longer matches the credential row; this build cannot continue. */
export class BuilderTargetMismatchError extends Error {
  constructor() {
    super('The environment build target no longer matches its credential');
    this.name = 'BuilderTargetMismatchError';
  }
}

/** Persisted lifecycle state is unreadable; do not guess and risk a duplicate. */
export class BuilderStateInvalidError extends Error {
  constructor() {
    super('Environment builder lifecycle state is invalid');
    this.name = 'BuilderStateInvalidError';
  }
}

/** A create request did not become observable within the settle bound. */
export class BuilderCreateUncertainError extends Error {
  constructor() {
    super('Vercel builder create did not settle');
    this.name = 'BuilderCreateUncertainError';
  }
}
