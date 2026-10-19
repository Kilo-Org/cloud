import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type { SandboxSessionV2 } from '../../control-plane/session/session-do.js';
import {
  hostedSessionLifecycleSchema,
  type HostedSessionLifecycle,
  type HostedSessionLifecycleResult,
} from '../../shared/hosted-session-lifecycle.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';

const hostedSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

export const HostedSessionLifecycleInput = z
  .object({ cloudAgentSessionId: hostedSessionIdSchema })
  .strict();

export const HostedSessionLifecycleOutput = z
  .object({
    cloudAgentSessionId: hostedSessionIdSchema,
    kiloSessionId: z.string().min(1),
    lifecycle: hostedSessionLifecycleSchema,
  })
  .strict();

function lifecycleResult(
  result: HostedSessionLifecycleResult,
  cloudAgentSessionId: `workspace_${string}`,
  kiloSessionId: string
): {
  cloudAgentSessionId: `workspace_${string}`;
  kiloSessionId: string;
  lifecycle: HostedSessionLifecycle;
} {
  if (result.type === 'session-not-found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Hosted session not found' });
  }
  return { cloudAgentSessionId, kiloSessionId, lifecycle: result.lifecycle };
}

type HostedLifecycleContext = TRPCContext & { userId: string; authToken: string };

function hostedLifecycleProcedure(
  operation: (stub: DurableObjectStub<SandboxSessionV2>) => Promise<HostedSessionLifecycleResult>,
  operationName: string,
  procedure: 'query' | 'mutation'
) {
  const builder = protectedProcedure
    .input(HostedSessionLifecycleInput)
    .output(HostedSessionLifecycleOutput);
  const resolve = async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof HostedSessionLifecycleInput>;
    ctx: HostedLifecycleContext;
  }) => {
    const access = await requireCurrentSessionAccess({
      env: ctx.env,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: input.cloudAgentSessionId,
    });
    const result = await withDORetry(
      () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
      operation,
      operationName
    );
    return lifecycleResult(result, input.cloudAgentSessionId, access.kiloSessionId);
  };
  return procedure === 'query' ? builder.query(resolve) : builder.mutation(resolve);
}

export const hostedSessionLifecycleRouter = {
  getHostedSessionLifecycle: hostedLifecycleProcedure(
    stub => stub.getHostedLifecycle(),
    'getHostedLifecycle',
    'query'
  ),
  stopHostedSession: hostedLifecycleProcedure(
    stub => stub.stopHostedSession(),
    'stopHostedSession',
    'mutation'
  ),
  resumeHostedSession: hostedLifecycleProcedure(
    stub => stub.resumeHostedSession(),
    'resumeHostedSession',
    'mutation'
  ),
};
