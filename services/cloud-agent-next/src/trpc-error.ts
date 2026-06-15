import { PublicErrorCodeSchema, type ClientError } from '@kilocode/worker-utils/client-error';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';

const NON_RETRYABLE_CODES = new Set([
  'PARSE_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'NOT_IMPLEMENTED',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_CONTENT',
]);

const STATUS_TO_TRPC_CODE = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_SUPPORTED',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_CONTENT',
  429: 'TOO_MANY_REQUESTS',
  499: 'CLIENT_CLOSED_REQUEST',
  501: 'NOT_IMPLEMENTED',
  503: 'SERVICE_UNAVAILABLE',
} satisfies Partial<Record<number, keyof typeof TRPC_ERROR_CODES_BY_KEY>>;

type TrpcErrorData = {
  code: string;
  httpStatus: number;
  path?: string;
  [key: string]: unknown;
};

type ExplicitLegacyCause = {
  error: string;
  retryable: boolean;
};

function parseExplicitLegacyCause(cause: unknown): ExplicitLegacyCause | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  if (!('error' in cause) || !('retryable' in cause)) return undefined;
  const parsedError = PublicErrorCodeSchema.safeParse(cause.error);
  if (!parsedError.success || typeof cause.retryable !== 'boolean') {
    return undefined;
  }
  if ('message' in cause && cause.message !== undefined && typeof cause.message !== 'string') {
    return undefined;
  }
  return { error: parsedError.data, retryable: cause.retryable };
}

export function createClientError(code: string, message: string, retryable?: boolean): ClientError {
  return {
    code,
    message,
    retryable: NON_RETRYABLE_CODES.has(code) ? false : (retryable ?? true),
  };
}

export function projectTrpcErrorData(
  data: TrpcErrorData,
  message: string,
  cause?: unknown
): TrpcErrorData & { clientError: ClientError } {
  const explicitCause = parseExplicitLegacyCause(cause);
  if (explicitCause) {
    const clientError = createClientError(explicitCause.error, message, explicitCause.retryable);
    return {
      ...data,
      error: explicitCause.error,
      retryable: clientError.retryable,
      clientError,
    };
  }
  return {
    ...data,
    clientError: createClientError(data.code, message),
  };
}

export function buildTrpcErrorResponse(status: number, message: string, path?: string): Response {
  const code =
    STATUS_TO_TRPC_CODE[status as keyof typeof STATUS_TO_TRPC_CODE] ?? 'INTERNAL_SERVER_ERROR';

  return new Response(
    JSON.stringify({
      error: {
        message,
        code: TRPC_ERROR_CODES_BY_KEY[code],
        data: projectTrpcErrorData({ code, httpStatus: status, path }, message),
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
