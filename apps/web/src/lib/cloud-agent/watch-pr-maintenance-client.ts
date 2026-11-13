import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  watchPrMaintenanceResultSchema,
  watchPrPublicationEvidenceSchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';

const ownerSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().uuid().optional(),
});
const workspaceSchema = ownerSchema.extend({ worktreeId: z.string().min(1) });
const workspaceOutputSchema = z.object({
  worktreeId: z.string(),
  profileId: z.string().uuid().nullable(),
  environmentId: z.string().uuid().nullable(),
  purpose: z.string().nullable(),
  constraints: z.array(z.string()),
  model: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  sourceKiloSessionId: z.string(),
  sourceCloudAgentSessionId: z.string(),
  repoUrl: z.string().optional(),
  headRef: z.string().optional(),
});
const messageSchema = z
  .object({
    messageId: z.string(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
    failureCode: z.string().nullable().optional(),
  })
  .passthrough();
export const maintenanceStatusSchema = z.object({
  message: messageSchema.nullable(),
  latestMessage: messageSchema.nullable(),
  waitingForInput: z.boolean(),
  stoppedAt: z.number().nullable(),
  resultMessageId: z.string().nullable().optional(),
  publicationMessageId: z.string().nullable().optional(),
  lastPublished: z
    .object({ messageId: z.string(), publication: watchPrPublicationEvidenceSchema })
    .nullable()
    .optional(),
  result: watchPrMaintenanceResultSchema.nullable(),
  publication: watchPrPublicationEvidenceSchema.nullable(),
});

async function call<T>(
  operation: string,
  body: unknown,
  output: z.ZodType<T>,
  timeoutMs = 25_000
): Promise<T> {
  const baseUrl = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');
  if (!baseUrl || !INTERNAL_API_SECRET) throw new Error('Maintenance runtime is not configured');
  const response = await fetch(new URL(`/internal/pr-maintenance/${operation}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-key': INTERNAL_API_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new TRPCError({
      code:
        response.status === 403
          ? 'FORBIDDEN'
          : response.status === 409 || response.status === 400
            ? 'PRECONDITION_FAILED'
            : 'SERVICE_UNAVAILABLE',
      message: `Maintenance runtime ${operation} returned ${response.status}`,
    });
  return output.parse(await response.json());
}

export function maintenanceWorkspace(input: z.infer<typeof workspaceSchema>) {
  return call('workspace', workspaceSchema.parse(input), workspaceOutputSchema);
}

export function scheduleWatchPr(watchId: string, dueAt: string) {
  return call(
    'schedule',
    { watchId, dueAt: new Date(dueAt).toISOString() },
    z.object({ scheduled: z.literal(true) }),
    5_000
  );
}

export function startMaintenanceChat(
  input: z.infer<typeof ownerSchema> & {
    worktreeId: string;
    watchId: string;
    attemptId: string;
    creationOperationKey: string;
    kiloSessionId: string;
    cloudAgentSessionId: string;
    messageId: string;
    prompt: string;
    model: string;
    allowRebase: boolean;
    recoverableAttemptIds: string[];
    parentCommitSha: string | null;
    variant?: string;
    profileId: string | null;
    environmentId: string | null;
    runtimeToken: string;
    runtimeAuthorizationSeal: string;
    publication: {
      repoUrl: string;
      headRef: string;
      baseRef: string;
      observedHeadSha: string;
      baseSha: string;
    };
  }
) {
  return call(
    'start',
    input,
    z.object({
      worktreeId: z.string(),
      kiloSessionId: z.string(),
      cloudAgentSessionId: z.string(),
      messageId: z.string(),
      replayed: z.boolean().optional(),
    })
  );
}

export function maintenanceChatStatus(
  input: z.infer<typeof ownerSchema> & { cloudAgentSessionId: string; messageId: string }
) {
  return call(
    'status',
    {
      userId: input.userId,
      cloudAgentSessionId: input.cloudAgentSessionId,
      messageId: input.messageId,
    },
    maintenanceStatusSchema.nullable()
  );
}

export function stopMaintenanceChat(
  input: z.infer<typeof ownerSchema> & {
    cloudAgentSessionId: string;
    messageId: string;
    watchId: string;
    attemptId: string;
  }
) {
  return call(
    'stop',
    {
      userId: input.userId,
      cloudAgentSessionId: input.cloudAgentSessionId,
      messageId: input.messageId,
      watchId: input.watchId,
      attemptId: input.attemptId,
    },
    maintenanceStatusSchema.nullable()
  );
}
