import type { TRPCClient } from '@trpc/client';
import type { inferRouterInputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

/** The ids one create request sends; a retry of the same request reuses both. */
export type LocalSessionAttempt = { kiloSessionId: string; operationKey: string };

type RouterInputs = inferRouterInputs<RootRouter>;
type WithoutAttempt<Input> = Input extends unknown ? Omit<Input, keyof LocalSessionAttempt> : never;

/**
 * The create request a local session stands for, kept as data so it can be
 * stored and sent again after a reload under the same attempt.
 */
export type LocalSessionRequest =
  | { kind: 'worktree-chat'; sourceKiloSessionId: string }
  | {
      kind: 'new-session';
      input: WithoutAttempt<RouterInputs['cloudAgentNext']['prepareSession']>;
    }
  | {
      kind: 'new-organization-session';
      input: WithoutAttempt<RouterInputs['organizations']['cloudAgentNext']['prepareSession']>;
    };

export async function releaseLocalSessionUploads(
  client: TRPCClient<RootRouter>,
  request: LocalSessionRequest,
  userId: string
): Promise<void> {
  if (request.kind === 'worktree-chat') return;
  const attachments = request.input.attachments;
  if (!attachments?.files.length) return;
  const objectKeys = attachments.files.map(
    file => `${userId}/cloud-agent/${attachments.path}/${file}`
  );
  if (request.kind === 'new-organization-session') {
    await client.organizations.cloudAgentNext.releasePendingUploads.mutate({
      organizationId: request.input.organizationId,
      objectKeys,
    });
  } else {
    await client.cloudAgentNext.releasePendingUploads.mutate({ objectKeys });
  }
}

/** Sends one attempt of the request. Returns the id the server created the session under. */
export async function sendLocalSessionRequest(
  client: TRPCClient<RootRouter>,
  request: LocalSessionRequest,
  organizationId: string | null,
  { kiloSessionId, operationKey }: LocalSessionAttempt
): Promise<string> {
  const attempt = { kiloSessionId, operationKey };
  switch (request.kind) {
    case 'worktree-chat': {
      const input = { sourceKiloSessionId: request.sourceKiloSessionId, ...attempt };
      const result = organizationId
        ? await client.organizations.cloudAgentNext.createWorktreeChat.mutate({
            ...input,
            organizationId,
          })
        : await client.cloudAgentNext.createWorktreeChat.mutate(input);
      return result.kiloSessionId;
    }
    case 'new-session':
      return (await client.cloudAgentNext.prepareSession.mutate({ ...request.input, ...attempt }))
        .kiloSessionId;
    case 'new-organization-session':
      return (
        await client.organizations.cloudAgentNext.prepareSession.mutate({
          ...request.input,
          ...attempt,
        })
      ).kiloSessionId;
  }
}
