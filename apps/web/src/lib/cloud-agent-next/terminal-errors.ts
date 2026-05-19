import 'server-only';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';

type TerminalTRPCCode = 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE';
type TerminalClientErrorShape = {
  data?: unknown;
  shape?: { data?: unknown } | null;
};

const HTTP_STATUS_TO_CODE = new Map<number, TerminalTRPCCode>([
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [412, 'PRECONDITION_FAILED'],
  [503, 'SERVICE_UNAVAILABLE'],
]);

function readHttpStatus(error: TerminalClientErrorShape): number | undefined {
  const data = error.data as { httpStatus?: unknown } | undefined;
  if (typeof data?.httpStatus === 'number') return data.httpStatus;

  const shapeData = error.shape?.data as { httpStatus?: unknown } | undefined;
  if (typeof shapeData?.httpStatus === 'number') return shapeData.httpStatus;

  return undefined;
}

function readCode(error: TerminalClientErrorShape): TerminalTRPCCode | undefined {
  const data = error.data as { code?: unknown } | undefined;
  const code = data?.code;
  if (
    code === 'NOT_FOUND' ||
    code === 'FORBIDDEN' ||
    code === 'PRECONDITION_FAILED' ||
    code === 'SERVICE_UNAVAILABLE'
  ) {
    return code;
  }

  const httpStatus = readHttpStatus(error);
  return httpStatus === undefined ? undefined : HTTP_STATUS_TO_CODE.get(httpStatus);
}

export function rethrowAsTerminalError(error: unknown): never {
  if (error instanceof TRPCClientError) {
    const code = readCode(error);
    if (code) {
      throw new TRPCError({ code, message: error.message });
    }
  }

  throw error;
}
