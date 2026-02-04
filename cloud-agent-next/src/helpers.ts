import { getSandbox } from '@cloudflare/sandbox';
import type { TRPCContext } from './types.js';

/**
 * Sets up a sandbox instance and invokes a callback.
 * Simplifies sandbox initialization by encapsulating the setup logic.
 * @param ctx The TRPC context containing environment
 * @param sandboxId The sandbox identifier for sandbox isolation
 * @param fn Async callback that receives the configured sandbox instance
 * @returns The result of the callback function
 */
export async function withSandbox<T>(
  ctx: TRPCContext,
  sandboxId: string,
  fn: (sandbox: ReturnType<typeof getSandbox>) => Promise<T>
): Promise<T> {
  const sandbox = getSandbox(ctx.env.Sandbox, sandboxId);
  return await fn(sandbox);
}
