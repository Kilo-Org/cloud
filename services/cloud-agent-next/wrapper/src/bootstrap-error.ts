import type { WorkspaceFailureSubtype } from '../../src/shared/wrapper-bootstrap.js';

export type WrapperBootstrapErrorCode =
  | 'WORKSPACE_RECONCILIATION_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'KILO_SERVER_FAILED';

export class WrapperBootstrapError extends Error {
  readonly code: WrapperBootstrapErrorCode;
  readonly subtype?: WorkspaceFailureSubtype;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(options: {
    code: WrapperBootstrapErrorCode;
    subtype?: WorkspaceFailureSubtype;
    message: string;
    detail?: string;
    retryable: boolean;
  }) {
    super(options.message);
    this.name = 'WrapperBootstrapError';
    this.code = options.code;
    this.subtype = options.subtype;
    this.detail = options.detail;
    this.retryable = options.retryable;
  }
}

export function workspaceBootstrapError(
  subtype: WorkspaceFailureSubtype,
  message: string,
  detail?: string,
  retryable = true
): WrapperBootstrapError {
  return new WrapperBootstrapError({
    code: 'WORKSPACE_SETUP_FAILED',
    subtype,
    message,
    detail,
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
