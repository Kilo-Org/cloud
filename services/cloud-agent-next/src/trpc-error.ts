import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';

export function buildTrpcErrorResponse(status: number, message: string, path?: string): Response {
  const code = (() => {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 402:
        return 'PAYMENT_REQUIRED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  })();

  return new Response(
    JSON.stringify({
      error: {
        message,
        code: TRPC_ERROR_CODES_BY_KEY[code],
        data: {
          code,
          httpStatus: status,
          path,
        },
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
