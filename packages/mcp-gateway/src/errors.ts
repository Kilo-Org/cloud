export const GatewayErrorCode = {
  InvalidRequest: 'invalid_request',
  InvalidClient: 'invalid_client',
  InvalidClientMetadata: 'invalid_client_metadata',
  InvalidGrant: 'invalid_grant',
  InvalidScope: 'invalid_scope',
  UnauthorizedClient: 'unauthorized_client',
  AccessDenied: 'access_denied',
  UnsupportedGrantType: 'unsupported_grant_type',
  ServerError: 'server_error',
  TemporarilyUnavailable: 'temporarily_unavailable',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
} as const;

export type GatewayErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;

  constructor(code: GatewayErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

export function createGatewayError(code: GatewayErrorCode, message: string, status: number) {
  return new GatewayError(code, message, status);
}
