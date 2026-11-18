import { z } from 'zod';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';

/**
 * Local receipt for the migrated `CANCEL{message}` cancellation contract. The
 * outward contract is preserved deliberately: a receipt with `state`/`message`
 * that `user-kilo-facade.ts` maps to `{success}` / `{success:false,message}`.
 * The `shared/control-plane-session.ts` schemas are not imported here so C3d can
 * delete them with their last consumer.
 */
export const controlCancelReceiptSchema = z
  .object({
    state: z.enum(['accepted', 'confirmed', 'unconfirmed', 'rejected']),
    message: z.string().optional(),
  })
  .strict();
export type ControlCancelReceipt = z.infer<typeof controlCancelReceiptSchema>;

type ControlCancelSession = {
  stop: () => Promise<{ interrupted: boolean }>;
};

type ControlSessionCancelDependencies = {
  getStub?: () => ControlCancelSession;
  retry?: <T>(
    operation: (session: ControlCancelSession) => Promise<T>,
    operationName: string
  ) => Promise<T>;
};

/**
 * Interrupts a control-plane session through the V2 Session DO. `stop()` is
 * always called and reports whether it cancelled open work; a session with no
 * accepted/queued message returns `undefined`, which the caller maps to the
 * legacy "no session work to interrupt" outcome.
 */
export async function interruptControlSession(
  input: {
    env: Pick<Env, 'SANDBOX_SESSION'>;
    ownerId: string;
    sessionId: string;
  },
  dependencies: ControlSessionCancelDependencies = {}
): Promise<ControlCancelReceipt | undefined> {
  const stub =
    dependencies.getStub ??
    (() => getSandboxSessionStub(input.env, input.ownerId, input.sessionId));
  const retry =
    dependencies.retry ??
    (<T>(operation: (session: ControlCancelSession) => Promise<T>, operationName: string) =>
      withDORetry(stub, operation, operationName));
  const result = await retry(session => session.stop(), 'stop');
  if (!result.interrupted) return undefined;
  return controlCancelReceiptSchema.parse({ state: 'confirmed' });
}
