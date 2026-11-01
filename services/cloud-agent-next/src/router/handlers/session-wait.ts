import { TRPCError } from '@trpc/server';
import type * as z from 'zod';
import { withLogTags } from '../../logger.js';
import type { SessionId } from '../../types.js';
import { getSandboxSessionStub, type SessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type { MessageResultRPCResponse } from '../../session/message-result.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  type PendingInteractionsOutput,
  WaitForMessageResultInput,
  WaitForMessageResultOutput,
  type GetMessageResultResponse,
} from '../schemas.js';

type WaitObservation = {
  result: GetMessageResultResponse;
  pendingInteractions: z.infer<typeof PendingInteractionsOutput>;
};

export type WaitPollingDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
};

const defaultWaitPollingDeps: WaitPollingDeps = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  intervalMs: 500,
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

function isDecisive(observation: WaitObservation): boolean {
  return (
    TERMINAL_STATUSES.has(observation.result.status) ||
    observation.pendingInteractions.questions.length > 0 ||
    observation.pendingInteractions.permissions.length > 0
  );
}

export async function readMessageResult(
  getStub: () => SessionStub,
  messageId: string
): Promise<GetMessageResultResponse> {
  const response: MessageResultRPCResponse = await withDORetry(
    getStub,
    async stub => await stub.getMessageResult(messageId),
    'getMessageResult'
  );
  if (response.type === 'session-not-found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  if (response.type === 'message-not-found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' });
  }
  if (response.type === 'state-invalid') {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Message result unavailable' });
  }
  return response.result;
}

export async function waitForMessageResultObservation(
  read: () => Promise<WaitObservation>,
  timeoutSeconds: number,
  deps: WaitPollingDeps = defaultWaitPollingDeps
): Promise<WaitObservation & { timedOut: boolean }> {
  const deadline = deps.now() + timeoutSeconds * 1000;
  for (;;) {
    const observation = await read();
    if (isDecisive(observation)) {
      return { ...observation, timedOut: false };
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return { ...observation, timedOut: true };
    }
    await deps.sleep(Math.min(deps.intervalMs, remaining));
  }
}

export function createSessionWaitHandlers(deps: WaitPollingDeps = defaultWaitPollingDeps) {
  return {
    waitForMessageResult: protectedProcedure
      .input(WaitForMessageResultInput)
      .output(WaitForMessageResultOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'waitForMessageResult' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });
          const getStub = () => getSandboxSessionStub(env, userId, sessionId);

          const read = async (): Promise<WaitObservation> => {
            const result = await readMessageResult(getStub, input.messageId);
            const pendingInteractions: z.infer<typeof PendingInteractionsOutput> =
              await withDORetry(
                getStub,
                stub => stub.getPendingInteractions(),
                'getPendingInteractions'
              );
            return { result, pendingInteractions };
          };

          return await waitForMessageResultObservation(read, input.timeoutSeconds, deps);
        });
      }),
  };
}
