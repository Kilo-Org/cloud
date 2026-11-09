import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import {
  cloudAgentSessionIdSchema,
  cloudAgentWorktreeIdSchema,
} from '@kilocode/session-ingest-contracts';
import type {
  WorktreeBranchOperationRefusalReason,
  WorktreeBranchOperationResult,
} from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import { useRawTRPCClient } from '@/lib/trpc/utils';

export type { WorktreeBranchOperationResult };

export type WorktreeBranchOperationTarget = {
  worktreeId: string;
  cloudAgentSessionId: string;
  branch: string | null;
  baseBranch: string | null;
  label: string;
  prNumber: number | null;
  prState: string | null;
  prUrl: string | null;
  stackNumber: number | null;
  stackPosition: number | null;
  isRoot: boolean;
};

type WorktreeBranchOperationTargetInput = Pick<
  WorktreeBranchOperationTarget,
  'worktreeId' | 'cloudAgentSessionId'
>;

export type RestackStackStep = {
  target: WorktreeBranchOperationTarget;
  result: WorktreeBranchOperationResult;
};

export type RestackStackResult = {
  results: RestackStackStep[];
  stopped: RestackStackStep | null;
};

export type WorktreeInstructionDispatchResult = 'sent' | 'manual' | 'failed';

type SendInstruction = (instruction: string) => Promise<boolean | void> | boolean | void;

function refused(
  reason: WorktreeBranchOperationRefusalReason,
  message: string
): WorktreeBranchOperationResult {
  return {
    status: 'refused',
    operation: 'restack',
    branch: null,
    baseBranch: null,
    baseSha: null,
    previousRemoteSha: null,
    remoteSha: null,
    headSha: null,
    reason,
    message,
  };
}

function completed(result: WorktreeBranchOperationResult): boolean {
  return result.status === 'changed' || result.status === 'unchanged';
}

export function orderRestackTargets(
  targets: readonly WorktreeBranchOperationTarget[]
): WorktreeBranchOperationTarget[] {
  return targets.filter(target => !target.isRoot && Boolean(target.cloudAgentSessionId));
}

export async function restackStackTargets(
  targets: readonly WorktreeBranchOperationTarget[],
  restack: (target: WorktreeBranchOperationTarget) => Promise<WorktreeBranchOperationResult>
): Promise<RestackStackResult> {
  const results: RestackStackStep[] = [];
  for (const target of orderRestackTargets(targets)) {
    let result = await restack(target);
    if (completed(result) && result.operation === 'sync') {
      result = await restack(target);
      if (!completed(result) || result.operation !== 'restack') {
        return { results, stopped: { target, result } };
      }
    }
    results.push({ target, result });
    if (!completed(result)) return { results, stopped: { target, result } };
  }
  return { results, stopped: null };
}

export function useWorktreeBranchOperations({
  organizationId,
  currentCloudAgentSessionId,
  onCompleted,
}: {
  organizationId?: string | null;
  currentCloudAgentSessionId?: string | null;
  onCompleted?: () => void;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);
  const [lastResult, setLastResult] = useState<WorktreeBranchOperationResult | null>(null);

  const run = useCallback(
    async (target: WorktreeBranchOperationTargetInput): Promise<WorktreeBranchOperationResult> => {
      let result: WorktreeBranchOperationResult;
      const sessionId = cloudAgentSessionIdSchema.safeParse(target.cloudAgentSessionId);
      if (!sessionId.success) {
        result = refused(
          'branch_mismatch',
          'The worktree does not have a Cloud Agent session to operate on.'
        );
      } else {
        try {
          result = organizationId
            ? await trpcClient.organizations.cloudAgentNext.restackWorktreeBranch.mutate({
                organizationId,
                cloudAgentSessionId: sessionId.data,
              })
            : await trpcClient.cloudAgentNext.restackWorktreeBranch.mutate({
                cloudAgentSessionId: sessionId.data,
              });
        } catch (error) {
          result = refused(
            'remote_branch_not_changed',
            error instanceof Error ? error.message : 'The branch operation failed.'
          );
        }
      }
      setLastResult(result);
      if (completed(result)) {
        void queryClient.invalidateQueries({
          predicate: query => {
            const scope = query.queryKey[3];
            return (
              query.queryKey[0] === 'worktree-changes' &&
              Array.isArray(scope) &&
              scope[0] === 'worktree' &&
              scope[1] === target.worktreeId
            );
          },
        });
        onCompleted?.();
      }
      return result;
    },
    [onCompleted, organizationId, queryClient, trpcClient]
  );

  const runOne = useCallback(
    async (target: WorktreeBranchOperationTargetInput): Promise<WorktreeBranchOperationResult> => {
      if (pendingRef.current) {
        return refused('turn_running', 'Another branch operation is already running.');
      }
      pendingRef.current = true;
      setIsPending(true);
      try {
        return await run(target);
      } finally {
        pendingRef.current = false;
        setIsPending(false);
      }
    },
    [run]
  );

  const restack = useCallback(
    (target: WorktreeBranchOperationTargetInput) => runOne(target),
    [runOne]
  );

  const restackStack = useCallback(
    async (targets: readonly WorktreeBranchOperationTarget[]): Promise<RestackStackResult> => {
      if (pendingRef.current) {
        const target = orderRestackTargets(targets)[0];
        return {
          results: [],
          stopped: target
            ? {
                target,
                result: refused('turn_running', 'Another branch operation is already running.'),
              }
            : null,
        };
      }
      pendingRef.current = true;
      setIsPending(true);
      try {
        return await restackStackTargets(targets, target => run(target));
      } finally {
        pendingRef.current = false;
        setIsPending(false);
      }
    },
    [run]
  );

  return {
    isPending,
    lastResult,
    currentCloudAgentSessionId,
    restack,
    restackStack,
  };
}

export async function dispatchWorktreeInstruction({
  trpcClient,
  organizationId,
  currentCloudAgentSessionId,
  onSendInstruction,
  target,
  instruction,
}: {
  trpcClient: ReturnType<typeof useRawTRPCClient>;
  organizationId?: string | null;
  currentCloudAgentSessionId?: string | null;
  onSendInstruction?: SendInstruction;
  target: Pick<WorktreeBranchOperationTarget, 'worktreeId' | 'cloudAgentSessionId'>;
  instruction: string;
}): Promise<WorktreeInstructionDispatchResult> {
  if (target.cloudAgentSessionId === currentCloudAgentSessionId && onSendInstruction) {
    try {
      const sent = await onSendInstruction(instruction);
      return sent === false ? 'manual' : 'sent';
    } catch {
      return 'failed';
    }
  }
  const sessionId = cloudAgentSessionIdSchema.safeParse(target.cloudAgentSessionId);
  const worktreeId = cloudAgentWorktreeIdSchema.safeParse(target.worktreeId);
  if (!sessionId.success || !worktreeId.success) return 'failed';
  try {
    const session = organizationId
      ? await trpcClient.organizations.cloudAgentNext.getSession.query({
          organizationId,
          cloudAgentSessionId: sessionId.data,
        })
      : await trpcClient.cloudAgentNext.getSession.query({
          cloudAgentSessionId: sessionId.data,
        });
    if (!session.userId || !session.model || !session.mode) return 'failed';
    const payload = {
      cloudAgentSessionId: sessionId.data,
      payload: {
        type: 'prompt' as const,
        prompt: instruction,
        mode: session.mode,
        model: session.model,
      },
      expectedWorktreeId: worktreeId.data,
      messageId: generateMessageId(),
    };
    if (organizationId) {
      await trpcClient.organizations.cloudAgentNext.sendMessage.mutate({
        ...payload,
        organizationId,
      });
    } else {
      await trpcClient.cloudAgentNext.sendMessage.mutate(payload);
    }
    return 'sent';
  } catch {
    return 'failed';
  }
}

export function useWorktreeInstructionDispatcher({
  organizationId,
  currentCloudAgentSessionId,
  onSendInstruction,
}: {
  organizationId?: string | null;
  currentCloudAgentSessionId?: string | null;
  onSendInstruction?: SendInstruction;
}) {
  const trpcClient = useRawTRPCClient();
  return useCallback(
    (
      target: Pick<WorktreeBranchOperationTarget, 'worktreeId' | 'cloudAgentSessionId'>,
      instruction: string
    ) =>
      dispatchWorktreeInstruction({
        trpcClient,
        organizationId,
        currentCloudAgentSessionId,
        onSendInstruction,
        target,
        instruction,
      }),
    [currentCloudAgentSessionId, onSendInstruction, organizationId, trpcClient]
  );
}

export function buildBranchConflictInstruction(
  target: Pick<WorktreeBranchOperationTarget, 'label' | 'branch' | 'baseBranch'>,
  result: WorktreeBranchOperationResult
): string {
  if (result.status === 'conflict' && result.instruction.trim().length > 0) {
    return result.instruction;
  }
  const branch = target.branch ?? 'the current branch';
  const base = target.baseBranch ? `origin/${target.baseBranch}` : 'the new base';
  const command = result.status === 'conflict' ? result.command : `git rebase --onto ${base}`;
  const files =
    result.status === 'conflict' && result.files.length > 0
      ? ` Resolve the conflicts in ${result.files.join(', ')}.`
      : ' Resolve the conflicts.';
  return [
    `Restack \`${branch}\` in ${target.label} with \`${command}\`.`,
    files,
    'Run the relevant tests, then push with `--force-with-lease` only for this worktree’s own branch.',
    'message' in result && result.message ? `The branch operation reported: ${result.message}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
