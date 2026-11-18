import type { WorkspaceFailureSubtype } from '../../src/shared/wrapper-bootstrap.js';

export type WrapperBootstrapErrorCode =
  | 'WORKSPACE_RECONCILIATION_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'KILO_SERVER_FAILED';

export class WrapperBootstrapError extends Error {
  readonly code: WrapperBootstrapErrorCode;
  readonly subtype?: WorkspaceFailureSubtype;
  readonly detail?: string;
  /**
   * Bounded, allowlisted key=value provenance for a classified git failure
   * (`matcher`/`http`/`operation`/`route`). Never carries raw output, URLs,
   * paths or credentials. Wrapper-local; not part of any wire frame.
   */
  readonly gitFailure?: string;
  readonly retryable: boolean;

  constructor(options: {
    code: WrapperBootstrapErrorCode;
    subtype?: WorkspaceFailureSubtype;
    message: string;
    detail?: string;
    gitFailure?: string;
    retryable: boolean;
  }) {
    super(options.message);
    this.name = 'WrapperBootstrapError';
    this.code = options.code;
    this.subtype = options.subtype;
    this.detail = options.detail;
    this.gitFailure = options.gitFailure;
    this.retryable = options.retryable;
  }
}

export function workspaceBootstrapError(
  subtype: WorkspaceFailureSubtype,
  message: string,
  detail?: string,
  retryable = true,
  gitFailure?: string
): WrapperBootstrapError {
  return new WrapperBootstrapError({
    code: 'WORKSPACE_SETUP_FAILED',
    subtype,
    message,
    detail,
    ...(gitFailure === undefined ? {} : { gitFailure }),
    retryable,
  });
}

export function kiloServerBootstrapError(message: string, detail?: string): WrapperBootstrapError {
  return new WrapperBootstrapError({
    code: 'KILO_SERVER_FAILED',
    message,
    detail,
    retryable: true,
  });
}

export function kiloServerStartupError(): WrapperBootstrapError {
  return kiloServerBootstrapError('Failed to start Kilo server');
}
