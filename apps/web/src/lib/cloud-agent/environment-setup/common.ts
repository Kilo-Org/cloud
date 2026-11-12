import { AGENT_ENV_VARS_PUBLIC_KEY } from '@kilocode/web-shared/lib/config.server';

export const publicKey = AGENT_ENV_VARS_PUBLIC_KEY ?? '';

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
