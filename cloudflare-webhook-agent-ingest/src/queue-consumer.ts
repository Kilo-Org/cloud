import type { WebhookDeliveryMessage } from './util/queue';
import type { TriggerConfig, TriggerDO } from './dos/TriggerDO';
import { renderPromptTemplate } from './util/prompt-template';
import { logger } from './util/logger';
import { withDORetry } from './util/do-retry';
import { getTokenMintingService } from './services/token-minting-service.js';
import { getProfileResolutionService } from './services/profile-resolution-service.js';
import { z } from 'zod';

// Token cache TTL: 30 minutes. Token validity is 1 hour, so 30 min gives safety margin.
const TOKEN_CACHE_TTL_SECONDS = 30 * 60;

// Maximum number of retry attempts for failed webhook processing
const MAX_RETRY_ATTEMPTS = 3;

function tokenCacheKey(triggerConfig: TriggerConfig): string {
  // Cache key is based on userId or orgId, not namespace
  // This ensures token caching is per-user or per-org
  const principal = triggerConfig.userId ?? triggerConfig.orgId;
  return `webhook-token:${principal}`;
}

const PrepareSessionResponseSchema = z.object({
  result: z.object({
    data: z.object({
      cloudAgentSessionId: z.string(),
    }),
  }),
});

async function failRequest(
  stub: DurableObjectStub<TriggerDO>,
  requestId: string,
  message: string
): Promise<void> {
  await withDORetry(
    () => stub,
    doStub =>
      doStub.updateRequest(requestId, {
        process_status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: message,
      }),
    'updateRequest'
  );
}

/**
 * Get or mint a webhook API token.
 * First checks KV cache, then mints via Hyperdrive if not cached.
 */
async function getOrMintToken(
  env: Env,
  triggerConfig: TriggerConfig
): Promise<{ token: string; cached: boolean }> {
  const cacheKey = tokenCacheKey(triggerConfig);

  // Check KV cache first
  const cachedToken = await env.WEBHOOK_TOKEN_CACHE.get(cacheKey);
  if (cachedToken) {
    logger.debug('Token cache hit', { triggerId: triggerConfig.triggerId });
    return { token: cachedToken, cached: true };
  }

  logger.debug('Token cache miss, minting new token', { triggerId: triggerConfig.triggerId });

  // Mint token locally via Hyperdrive (singleton for connection pooling)
  const tokenMintingService = getTokenMintingService(env);
  const result = await tokenMintingService.mintToken({
    userId: triggerConfig.userId,
    orgId: triggerConfig.orgId,
    triggerId: triggerConfig.triggerId,
  });

  logger.debug('Token minted via Hyperdrive', {
    triggerId: triggerConfig.triggerId,
    userId: result.userId,
    isBot: result.isBot,
  });

  await env.WEBHOOK_TOKEN_CACHE.put(cacheKey, result.token, {
    expirationTtl: TOKEN_CACHE_TTL_SECONDS,
  });

  logger.debug('Token cached', {
    triggerId: triggerConfig.triggerId,
    ttl: TOKEN_CACHE_TTL_SECONDS,
  });

  return { token: result.token, cached: false };
}

async function processWebhookMessage(
  message: Message<WebhookDeliveryMessage>,
  env: Env
): Promise<void> {
  const webhook = message.body;
  let sessionCreated = false;
  let canRetryInitiate = false;
  let cloudAgentSessionId: string | null = null;

  logger.info('Processing webhook delivery', {
    namespace: webhook.namespace,
    triggerId: webhook.triggerId,
    requestId: webhook.requestId,
  });

  try {
    const doKey = `${webhook.namespace}/${webhook.triggerId}`;
    const doId = env.TRIGGER_DO.idFromName(doKey);
    const stub = env.TRIGGER_DO.get(doId);

    const [request, triggerConfig] = await Promise.all([
      withDORetry(
        () => stub,
        doStub => doStub.getRequest(webhook.requestId),
        'getRequest'
      ),
      withDORetry(
        () => stub,
        doStub => doStub.getConfig(),
        'getConfig'
      ),
    ]);

    if (!request) {
      logger.error('Request evicted before processing - data loss', {
        requestId: webhook.requestId,
        namespace: webhook.namespace,
        triggerId: webhook.triggerId,
        error: 'REQUEST_EVICTED',
      });
      message.ack();
      return;
    }

    if (!triggerConfig) {
      logger.error('Trigger config not found - trigger may have been deleted', {
        namespace: webhook.namespace,
        triggerId: webhook.triggerId,
        requestId: webhook.requestId,
      });
      await withDORetry(
        () => stub,
        doStub =>
          doStub.updateRequest(webhook.requestId, {
            process_status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Trigger configuration not found - trigger may have been deleted',
          }),
        'updateRequest'
      );
      message.ack();
      return;
    }

    if (request.processStatus === 'inprogress' && request.cloudAgentSessionId) {
      cloudAgentSessionId = request.cloudAgentSessionId;
      sessionCreated = true;
      canRetryInitiate = true;
    } else if (request.processStatus !== 'captured') {
      logger.info('Request already processed, skipping', {
        requestId: webhook.requestId,
        currentStatus: request.processStatus,
      });
      message.ack();
      return;
    }

    const { token } = await getOrMintToken(env, triggerConfig);

    // Fetch internalApiSecret once and reuse for both prepare/initiate calls
    const internalApiSecret = await env.INTERNAL_API_SECRET.get();

    if (!cloudAgentSessionId) {
      const renderedPrompt = renderPromptTemplate(triggerConfig.promptTemplate, {
        body: request.body,
        method: request.method,
        path: request.path,
        headers: request.headers,
        queryString: request.queryString,
        sourceIp: request.sourceIp,
        timestamp: request.timestamp,
      });

      logger.debug('Prompt rendered', {
        requestId: webhook.requestId,
        promptLength: renderedPrompt.length,
      });

      // Build callback target for completion notifications
      const callbackUrl = `${env.WEBHOOK_AGENT_URL}/api/callbacks/execution`;
      const callbackTarget = {
        url: callbackUrl,
        headers: {
          'x-internal-api-key': internalApiSecret,
          'x-webhook-namespace': webhook.namespace,
          'x-webhook-trigger-id': webhook.triggerId,
          'x-webhook-request-id': webhook.requestId,
        },
      };

      // Resolve profile at runtime via Hyperdrive if profileId is set
      if (!triggerConfig.profileId) {
        logger.error('No Agent Env Profile found.', {
          triggerId: triggerConfig.triggerId,
          requestId: webhook.requestId,
        });
        await failRequest(stub, webhook.requestId, 'No Agent Env Profile found.');
        message.ack();
        return;
      }

      logger.debug('Resolving profile for trigger', {
        triggerId: triggerConfig.triggerId,
        profileId: triggerConfig.profileId,
      });

      const profileService = getProfileResolutionService(env);
      const resolvedProfile = await profileService.resolveProfile({
        profileId: triggerConfig.profileId,
        userId: triggerConfig.userId,
        orgId: triggerConfig.orgId,
      });

      if (!resolvedProfile) {
        logger.error('No Agent Env Profile found.', {
          triggerId: triggerConfig.triggerId,
          profileId: triggerConfig.profileId,
          requestId: webhook.requestId,
        });
        await failRequest(stub, webhook.requestId, 'No Agent Env Profile found.');
        message.ack();
        return;
      }

      // Build prepareSession body with resolved profile values
      const prepareSessionBody: {
        prompt: string;
        mode: string;
        model: string;
        githubRepo: string;
        kilocodeOrganizationId?: string;
        callbackTarget: { url: string; headers: Record<string, string> };
        envVars?: Record<string, string>;
        encryptedSecrets?: Record<
          string,
          { encryptedData: string; encryptedDEK: string; algorithm: string; version: number }
        >;
        setupCommands?: string[];
        autoCommit?: boolean;
        condenseOnComplete?: boolean;
      } = {
        prompt: renderedPrompt,
        mode: triggerConfig.mode,
        model: triggerConfig.model,
        githubRepo: triggerConfig.githubRepo,
        callbackTarget,
      };

      if (triggerConfig.orgId) {
        prepareSessionBody.kilocodeOrganizationId = triggerConfig.orgId;
      }

      // Pass resolved profile values to cloud-agent
      if (Object.keys(resolvedProfile.envVars).length > 0) {
        prepareSessionBody.envVars = resolvedProfile.envVars;
      }
      if (Object.keys(resolvedProfile.encryptedSecrets).length > 0) {
        prepareSessionBody.encryptedSecrets = resolvedProfile.encryptedSecrets;
      }
      if (resolvedProfile.setupCommands.length > 0) {
        prepareSessionBody.setupCommands = resolvedProfile.setupCommands;
      }

      // Behavior flags from trigger config (not profile-related)
      if (triggerConfig.autoCommit !== undefined) {
        prepareSessionBody.autoCommit = triggerConfig.autoCommit;
      }
      if (triggerConfig.condenseOnComplete !== undefined) {
        prepareSessionBody.condenseOnComplete = triggerConfig.condenseOnComplete;
      }

      logger.debug('Calling prepareSession', {
        requestId: webhook.requestId,
        mode: triggerConfig.mode,
        model: triggerConfig.model,
        githubRepo: triggerConfig.githubRepo,
        callbackUrl,
      });

      const prepareResponse = await env.CLOUD_AGENT.fetch(
        new Request('https://cloud-agent/trpc/prepareSession', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-internal-api-key': internalApiSecret,
            'x-skip-balance-check': 'true',
          },
          body: JSON.stringify(prepareSessionBody),
        })
      );

      if (!prepareResponse.ok) {
        const errorBody = await prepareResponse.text();
        const errorMessage = (() => {
          try {
            const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
            return parsed.error?.message ?? errorBody;
          } catch {
            return errorBody;
          }
        })();
        if (prepareResponse.status >= 500) {
          throw new Error(`prepareSession failed: ${prepareResponse.status} - ${errorMessage}`);
        }

        logger.error('prepareSession failed (non-retriable)', {
          requestId: webhook.requestId,
          status: prepareResponse.status,
          error: errorBody,
        });

        await withDORetry(
          () => stub,
          doStub =>
            doStub.updateRequest(webhook.requestId, {
              process_status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: errorMessage,
            }),
          'updateRequest'
        );
        message.ack();
        return;
      }

      const prepareResult = PrepareSessionResponseSchema.parse(await prepareResponse.json());
      cloudAgentSessionId = prepareResult.result.data.cloudAgentSessionId;
      sessionCreated = true;

      logger.info('Cloud agent session created', {
        requestId: webhook.requestId,
        cloudAgentSessionId,
      });

      const updateResult = await withDORetry(
        () => stub,
        doStub =>
          doStub.updateRequest(webhook.requestId, {
            process_status: 'inprogress',
            started_at: new Date().toISOString(),
            cloud_agent_session_id: cloudAgentSessionId ?? undefined,
          }),
        'updateRequest'
      );

      if (updateResult.success) {
        canRetryInitiate = true;
      } else {
        logger.error('Failed to persist session id for request', {
          requestId: webhook.requestId,
          cloudAgentSessionId,
        });
      }
    }

    const initiateResponse = await env.CLOUD_AGENT.fetch(
      new Request('https://cloud-agent/trpc/initiateFromKilocodeSessionV2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-internal-api-key': internalApiSecret,
          'x-skip-balance-check': 'true',
        },
        body: JSON.stringify({ cloudAgentSessionId }),
      })
    );

    if (!initiateResponse.ok) {
      const errorBody = await initiateResponse.text();
      if (
        initiateResponse.status === 400 &&
        errorBody.includes('Session has already been initiated')
      ) {
        logger.info('Session already initiated, acknowledging', {
          requestId: webhook.requestId,
          cloudAgentSessionId,
        });
        message.ack();
        return;
      }
      if (initiateResponse.status === 402) {
        logger.warn('Insufficient balance for initiateFromKilocodeSessionV2', {
          requestId: webhook.requestId,
          cloudAgentSessionId,
          status: initiateResponse.status,
          error: errorBody,
        });
        await withDORetry(
          () => stub,
          doStub =>
            doStub.updateRequest(webhook.requestId, {
              process_status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: errorBody || 'Insufficient balance',
            }),
          'updateRequest'
        );
        message.ack();
        return;
      }
      if (initiateResponse.status >= 500) {
        throw new Error(
          `initiateFromKilocodeSessionV2 failed: ${initiateResponse.status} - ${errorBody}`
        );
      }
      logger.error('initiateFromKilocodeSessionV2 failed', {
        requestId: webhook.requestId,
        cloudAgentSessionId,
        status: initiateResponse.status,
        error: errorBody,
      });
      await withDORetry(
        () => stub,
        doStub =>
          doStub.updateRequest(webhook.requestId, {
            process_status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorBody,
          }),
        'updateRequest'
      );
      message.ack();
      return;
    }

    logger.info('Session initiated successfully', {
      requestId: webhook.requestId,
      cloudAgentSessionId: cloudAgentSessionId ?? 'unknown',
    });

    message.ack();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to process webhook', {
      requestId: webhook.requestId,
      namespace: webhook.namespace,
      triggerId: webhook.triggerId,
      error: errorMessage,
      attempts: message.attempts,
    });

    if ((!sessionCreated || canRetryInitiate) && message.attempts < MAX_RETRY_ATTEMPTS) {
      logger.info('Retrying message', {
        requestId: webhook.requestId,
        attempt: message.attempts,
      });
      message.retry();
      return;
    }

    // Always mark request as failed after max retries, regardless of whether session was created.
    // This prevents requests from getting stuck in 'captured' state when failures happen
    // before session creation (e.g., token minting errors).
    try {
      const doKey = `${webhook.namespace}/${webhook.triggerId}`;
      const doId = env.TRIGGER_DO.idFromName(doKey);
      const stub = env.TRIGGER_DO.get(doId);

      await withDORetry(
        () => stub,
        doStub =>
          doStub.updateRequest(webhook.requestId, {
            process_status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          }),
        'updateRequest'
      );
    } catch (updateError) {
      logger.error('Failed to update request status after failure', {
        requestId: webhook.requestId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    }

    message.ack();
  }
}

export async function handleWebhookDeliveryBatch(
  batch: MessageBatch<WebhookDeliveryMessage>,
  env: Env
): Promise<void> {
  logger.info('Processing webhook delivery batch', {
    queue: batch.queue,
    messageCount: batch.messages.length,
  });

  for (const message of batch.messages) {
    await processWebhookMessage(message, env);
  }

  logger.info('Webhook delivery batch processed', {
    queue: batch.queue,
    messageCount: batch.messages.length,
  });
}
