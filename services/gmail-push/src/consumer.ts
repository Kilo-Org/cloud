import { z } from 'zod';
import type { AppEnv, GmailPushQueueMessage } from './types';

const MAX_RETRIES = 6;
const BASE_DELAY_SECONDS = 60;

/** Schema for the base64-decoded Pub/Sub message data from Gmail. */
const GmailPubSubDataSchema = z.looseObject({
  historyId: z.union([z.string(), z.number()]).transform(String),
});

/** Schema for the outer Pub/Sub push envelope. */
const PubSubEnvelopeSchema = z.looseObject({
  message: z.looseObject({
    data: z.string(),
  }),
});

/**
 * Best-effort: extract historyId from Pub/Sub payload and report to DO.
 * Failures are logged but never cause message retry.
 */
async function reportHistoryId(
  userId: string,
  pubSubBody: string,
  env: AppEnv,
  internalSecret: string
): Promise<void> {
  try {
    const envelope = PubSubEnvelopeSchema.safeParse(JSON.parse(pubSubBody));
    if (!envelope.success) return;

    const decoded = GmailPubSubDataSchema.safeParse(JSON.parse(atob(envelope.data.message.data)));
    if (!decoded.success) return;

    const res = await env.KILOCLAW.fetch(
      new Request('https://kiloclaw/api/platform/gmail-history-id', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': internalSecret,
        },
        body: JSON.stringify({ userId, historyId: decoded.data.historyId }),
      })
    );
    if (!res.ok) {
      console.warn(`[gmail-push] Failed to record historyId for ${userId}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[gmail-push] Failed to report historyId for user ${userId}:`, err);
  }
}

async function retryWithBackoff(
  env: AppEnv,
  msg: GmailPushQueueMessage,
  currentAttempt: number
): Promise<void> {
  if (currentAttempt >= MAX_RETRIES) {
    console.error(
      `[gmail-push] Max retries (${MAX_RETRIES}) exceeded for message ${msg.messageId}, dropping`
    );
    return;
  }
  const delay = BASE_DELAY_SECONDS * Math.pow(2, currentAttempt);
  await env.GMAIL_PUSH_QUEUE.send({ ...msg, attempt: currentAttempt + 1 }, { delaySeconds: delay });
}

export async function handleQueue(
  batch: MessageBatch<GmailPushQueueMessage>,
  env: AppEnv
): Promise<void> {
  await Promise.allSettled(batch.messages.map(message => processMessage(message, env)));
}

async function processMessage(message: Message<GmailPushQueueMessage>, env: AppEnv): Promise<void> {
  const msg = message.body;
  const { userId, pubSubBody } = msg;
  const attempt = msg.attempt ?? 0;

  // Idempotency check only on first delivery (attempt 0).
  // There are two sources of redelivery:
  // 1. Pub/Sub redeliveries — same messageId, attempt 0. These are duplicates
  //    and must be blocked (the original was already enqueued or processed).
  // 2. Our own exponential retries — same messageId, attempt > 0. These are
  //    intentional re-enqueues after transient failures and must proceed.
  if (attempt === 0) {
    const id = env.IDEMPOTENCY.idFromName(userId);
    const stub = env.IDEMPOTENCY.get(id);
    const duplicate = await stub.checkAndMark(msg.messageId);
    if (duplicate) {
      message.ack();
      return;
    }
  }

  try {
    const internalSecret = await env.INTERNAL_API_SECRET.get();

    // Look up machine status via service binding
    const statusRes = await env.KILOCLAW.fetch(
      new Request(`https://kiloclaw/api/platform/status?userId=${encodeURIComponent(userId)}`, {
        headers: { 'x-internal-api-key': internalSecret },
      })
    );

    if (!statusRes.ok) {
      console.warn(`[gmail-push] Status lookup failed for user ${userId}: ${statusRes.status}`);
      await retryWithBackoff(env, msg, attempt);
      message.ack();
      return;
    }

    const status: {
      flyAppName: string | null;
      flyMachineId: string | null;
      sandboxId: string | null;
      status: string | null;
      gmailNotificationsEnabled: boolean;
    } = await statusRes.json();

    if (!status.flyAppName || !status.flyMachineId || status.status !== 'running') {
      console.warn(`[gmail-push] Machine not running for user ${userId}, retrying`);
      await retryWithBackoff(env, msg, attempt);
      message.ack();
      return;
    }

    if (!status.gmailNotificationsEnabled) {
      console.log(`[gmail-push] Notifications disabled for user ${userId}, dropping message`);
      message.ack();
      return;
    }

    // Get gateway token
    const tokenRes = await env.KILOCLAW.fetch(
      new Request(
        `https://kiloclaw/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': internalSecret } }
      )
    );

    if (!tokenRes.ok) {
      console.error(
        `[gmail-push] Gateway token lookup failed for user ${userId}: ${tokenRes.status}`
      );
      await retryWithBackoff(env, msg, attempt);
      message.ack();
      return;
    }

    const { gatewayToken }: { gatewayToken: string } = await tokenRes.json();

    // Forward push body to controller
    const machineUrl = `https://${status.flyAppName}.fly.dev`;
    const controllerRes = await fetch(`${machineUrl}/_kilo/gmail-pubsub`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayToken}`,
        'fly-force-instance-id': status.flyMachineId,
      },
      body: pubSubBody,
    });

    if (controllerRes.ok) {
      message.ack();
      await reportHistoryId(userId, pubSubBody, env, internalSecret);
      return;
    }

    // 400 and 422 are permanent client errors (bad request / validation) — don't retry.
    // 401 and 404 are transient: 401 = gateway token drift during restart/rotation,
    // 404 = old image not yet redeployed with the gmail-pubsub route.
    if (controllerRes.status === 400 || controllerRes.status === 422) {
      console.warn(
        `[gmail-push] Controller returned permanent ${controllerRes.status} for user ${userId}, dropping`
      );
      message.ack();
      return;
    }

    console.error(`[gmail-push] Controller returned ${controllerRes.status} for user ${userId}`);
    await retryWithBackoff(env, msg, attempt);
    message.ack();
  } catch (err) {
    console.error(`[gmail-push] Error delivering to user ${userId}:`, err);
    await retryWithBackoff(env, msg, attempt);
    message.ack();
  }
}
