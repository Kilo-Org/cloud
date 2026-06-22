const MISSING_CONTENT_SCRIPT_CONNECTION_ERROR = 'Receiving end does not exist';

export const isMissingContentScriptConnectionError = (error: unknown): error is Error =>
  error instanceof Error && error.message.includes(MISSING_CONTENT_SCRIPT_CONNECTION_ERROR);
