import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import { withDORetry } from '../../../utils/do-retry.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import { validateIdScopedSelectors } from '../../http-contract.js';

async function interruptPrompt(
  context: OwnedRootHandlerContext
): Promise<Awaited<ReturnType<CloudAgentSession['interruptExecution']>>> {
  if (context.deps?.interruptPrompt) {
    return context.deps.interruptPrompt({
      env: context.env,
      userId: context.userId,
      cloudAgentSessionId: context.cloudAgentSessionId,
    });
  }
  const id = context.env.CLOUD_AGENT_SESSION.idFromName(
    `${context.userId}:${context.cloudAgentSessionId}`
  );
  return withDORetry<
    DurableObjectStub<CloudAgentSession>,
    Awaited<ReturnType<CloudAgentSession['interruptExecution']>>
  >(
    () => context.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.interruptExecution(),
    'interruptExecution'
  );
}

export async function handleAbort(context: OwnedRootHandlerContext): Promise<Response> {
  const selectorResponse = validateIdScopedSelectors(context.url, context.kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;
  await interruptPrompt(context);
  return Response.json(true);
}
