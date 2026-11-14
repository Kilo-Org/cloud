import 'server-only';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { readCloudAgentErrorCode } from './cloud-agent-error';

const TERMINAL_TRPC_CODES = new Set<TRPC_ERROR_CODE_KEY>([
  'NOT_FOUND',
  'FORBIDDEN',
  'PRECONDITION_FAILED',
  'SERVICE_UNAVAILABLE',
]);

export function rethrowAsTerminalError(error: unknown): never {
  if (error instanceof TRPCClientError) {
    const code = readCloudAgentErrorCode(error, TERMINAL_TRPC_CODES);
    if (code) {
      throw new TRPCError({ code, message: error.message });
    }
  }

  throw error;
}
