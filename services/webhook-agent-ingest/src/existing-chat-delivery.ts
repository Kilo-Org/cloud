import { z } from 'zod';
import {
  checkWorkspaceChatTarget,
  workspaceChatTargetErrors,
} from '@kilocode/worker-utils/cloud-agent-session-access';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import {
  triggerChatIdRequired,
  triggerChatRequiresCreator,
} from '@kilocode/worker-utils/webhook-trigger-target';
import type { CapturedRequest, TriggerConfig, TriggerDO } from './dos/TriggerDO';
import type { RequestUpdates } from './db/types';
import { getWorkerDb } from './db/queries';
import {
  CreatorExecutionAuthorizationError,
  getTokenMintingService,
  PersonalExecutionAuthorizationError,
} from './services/token-minting-service';
import { withDORetry } from './util/do-retry';
import { renderPromptTemplate } from './util/prompt-template';
import { getSecretValue } from './util/secret';

export class ExistingChatDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

const sendAckSchema = z.object({
  result: z.object({ data: z.object({ cloudAgentSessionId: z.string(), messageId: z.string() }) }),
});

function sendRejection(status: number): ExistingChatDeliveryError {
  switch (status) {
    case 401:
    case 403:
      return new ExistingChatDeliveryError('Access to the target Cloud Agent chat was revoked.');
    case 404:
      return new ExistingChatDeliveryError(workspaceChatTargetErrors.not_found);
    case 402:
      return new ExistingChatDeliveryError(
        'Cloud Agent could not start the turn. Check available credits.'
      );
    case 429:
      return new ExistingChatDeliveryError('The target Cloud Agent chat queue is full.', true);
    default:
      return status >= 500 || status === 408 || status === 409
        ? new ExistingChatDeliveryError(
            'Cloud Agent could not accept the message temporarily.',
            true
          )
        : new ExistingChatDeliveryError(`Cloud Agent rejected the message (HTTP ${status}).`);
  }
}

export async function deliverExistingChatMessage(
  env: Env,
  getStub: () => DurableObjectStub<TriggerDO>,
  request: CapturedRequest,
  config: TriggerConfig
): Promise<void> {
  const cloudAgentSessionId = request.cloudAgentSessionId ?? config.cloudAgentSessionId;
  if (!cloudAgentSessionId) throw new ExistingChatDeliveryError(triggerChatIdRequired);
  const userId = config.executionUserId ?? config.userId;
  if (!userId || (config.orgId && !config.executionUserId)) {
    throw new ExistingChatDeliveryError(triggerChatRequiresCreator);
  }
  if (!config.mode || !config.model) {
    throw new ExistingChatDeliveryError('Set a mode and model for the existing chat trigger.');
  }

  const failure = await checkWorkspaceChatTarget(getWorkerDb(env.HYPERDRIVE.connectionString), {
    cloudAgentSessionId,
    userId,
    organizationId: config.orgId,
  });
  if (failure) throw new ExistingChatDeliveryError(workspaceChatTargetErrors[failure]);

  const { token } = await getTokenMintingService(env)
    .mintToken({
      userId: config.userId,
      orgId: config.orgId,
      executionUserId: config.executionUserId,
      triggerId: config.triggerId,
    })
    .catch((error: unknown) => {
      if (error instanceof PersonalExecutionAuthorizationError) {
        throw new ExistingChatDeliveryError(
          'The owner of the target Cloud Agent chat is blocked or no longer exists.'
        );
      }
      if (error instanceof CreatorExecutionAuthorizationError) {
        throw new ExistingChatDeliveryError(error.message);
      }
      throw error;
    });

  const saveRequest = (updates: RequestUpdates) =>
    withDORetry(getStub, stub => stub.updateRequest(request.id, updates), 'updateRequest');
  if (request.processStatus === 'captured') {
    const saved = await saveRequest({
      process_status: 'inprogress',
      started_at: new Date().toISOString(),
      cloud_agent_session_id: cloudAgentSessionId,
    });
    if (!saved.success) {
      throw new ExistingChatDeliveryError('Could not update request history before sending.', true);
    }
  }

  const digest = await sha256Hex(`webhook-trigger:${request.id}`);
  const messageId = `msg_${digest.slice(0, 26)}`;
  const internalApiSecret = await getSecretValue(env.INTERNAL_API_SECRET);
  const response = await env.CLOUD_AGENT.fetch(
    new Request('https://cloud-agent/trpc/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-internal-api-key': internalApiSecret,
      },
      body: JSON.stringify({
        cloudAgentSessionId,
        message: { id: messageId, prompt: renderPromptTemplate(config.promptTemplate, request) },
        agent: { mode: config.mode, model: config.model, variant: config.variant },
        finalization: {
          autoCommit: config.autoCommit,
          condenseOnComplete: config.condenseOnComplete,
        },
      }),
    })
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw sendRejection(response.status);
  }
  const ack = sendAckSchema.parse(await response.json()).result.data;
  if (ack.cloudAgentSessionId !== cloudAgentSessionId || ack.messageId !== messageId) {
    throw new ExistingChatDeliveryError(
      'Cloud Agent did not confirm the target chat message.',
      true
    );
  }

  const saved = await saveRequest({
    process_status: 'success',
    completed_at: new Date().toISOString(),
  });
  if (!saved.success) {
    throw new ExistingChatDeliveryError('Could not update request history after sending.', true);
  }
}
