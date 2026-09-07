import type { Env } from '../types.js';
import {
  controlSessionStateSchema,
  controlStopReceiptSchema,
  createControlStopRequest,
  type ControlStopReceipt,
} from '../shared/control-plane-session.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';

type ControlStopSession = {
  getControlState: () => Promise<unknown>;
  interruptExecution: (request: unknown) => Promise<unknown>;
};

type ControlSessionStopDependencies = {
  getStub?: () => ControlStopSession;
  retry?: <T>(
    operation: (session: ControlStopSession) => Promise<T>,
    operationName: string
  ) => Promise<T>;
  now?: number;
  operationId?: string;
};

export async function interruptControlSession(
  input: {
    env: Pick<Env, 'SANDBOX_SESSION'>;
    ownerId: string;
    sessionId: string;
  },
  dependencies: ControlSessionStopDependencies = {}
): Promise<ControlStopReceipt | undefined> {
  const stub =
    dependencies.getStub ??
    (() => getSandboxSessionStub(input.env, input.ownerId, input.sessionId));
  const retry =
    dependencies.retry ??
    (<T>(operation: (session: ControlStopSession) => Promise<T>, operationName: string) =>
      withDORetry(stub, operation, operationName));
  const state = await retry(session => session.getControlState(), 'getControlState');
  if (!state) return undefined;
  const request = createControlStopRequest(
    controlSessionStateSchema.parse(state),
    dependencies.now,
    dependencies.operationId
  );
  return retry(
    session =>
      session.interruptExecution(request).then(receipt => controlStopReceiptSchema.parse(receipt)),
    'interruptControlSession'
  );
}
