import type { CloudAgentEnvironmentSetupRun } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import { captureException } from '@sentry/nextjs';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import { computeCloudAgentNextBalanceCheckEligibility } from '@/lib/cloud-agent-next/balance-check-eligibility';
import {
  createCloudAgentNextClient,
  createCloudAgentNextClientForModel,
  type CloudAgentNextClient,
} from '@/lib/cloud-agent-next/cloud-agent-client';

export async function userCloudAgentClient(
  ctx: TRPCContext,
  organizationId?: string,
  model?: string
): Promise<CloudAgentNextClient> {
  const { token } = await createControlTokenForRequest(ctx.user, 'cloud-agent-next', {
    headers: ctx.headersList,
    ...(organizationId ? { organizationId } : {}),
    tokenSource: 'cloud-agent',
  });
  if (!model) {
    return createCloudAgentNextClient(token);
  }
  const eligibility = await computeCloudAgentNextBalanceCheckEligibility({
    fromDb: db,
    user: ctx.user,
    modelId: model,
    ...(organizationId ? { organizationId } : {}),
  });
  return createCloudAgentNextClientForModel(token, eligibility);
}

export async function sendSetupFollowUp(
  client: CloudAgentNextClient,
  run: CloudAgentEnvironmentSetupRun,
  prompt: string
): Promise<void> {
  if (!run.cloud_agent_session_id) return;
  try {
    await client.sendMessage({
      cloudAgentSessionId: run.cloud_agent_session_id,
      messageId: generateMessageId(),
      payload: {
        type: 'prompt',
        prompt,
        mode: 'code',
        model: run.data.model,
        ...(run.data.variant ? { variant: run.data.variant } : {}),
      },
      autoCommit: false,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'environment-setup', op: 'follow-up' },
      extra: { runId: run.id },
    });
  }
}
