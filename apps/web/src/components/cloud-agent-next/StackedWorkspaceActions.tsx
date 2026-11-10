'use client';

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, GitMerge, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  buildBranchConflictInstruction,
  useWorktreeBranchOperations,
  useWorktreeInstructionDispatcher,
  type WorktreeBranchOperationResult,
  type WorktreeBranchOperationTarget,
} from './useWorktreeBranchOperations';

type StackedWorkspaceActionsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreeId: string;
  cloudAgentSessionId: string;
  branch: string | null;
  baseBranch: string | null;
  stack: readonly WorktreeBranchOperationTarget[];
  organizationId?: string;
  onSendInstruction?: (instruction: string) => Promise<boolean | void> | boolean | void;
  onCompleted?: () => void;
};

function operationMessage(result: WorktreeBranchOperationResult): string | null {
  if (result.status === 'conflict') return null;
  if (result.status === 'refused') {
    return ('message' in result ? result.message : null) ?? 'The branch operation was refused.';
  }
  if (result.operation === 'sync') {
    return 'GitHub had already rebased this layer, so this was applied as a sync. Retry Restack to verify the branch.';
  }
  if (result.status === 'unchanged') {
    return 'Nothing to restack.';
  }
  return 'Restacked the branch.';
}

export function StackedWorkspaceActions({
  open,
  onOpenChange,
  worktreeId,
  cloudAgentSessionId,
  branch,
  baseBranch,
  stack,
  organizationId,
  onSendInstruction,
  onCompleted,
}: StackedWorkspaceActionsProps) {
  const operations = useWorktreeBranchOperations({
    organizationId: organizationId ?? null,
    currentCloudAgentSessionId: cloudAgentSessionId,
    onCompleted,
  });
  const dispatchInstruction = useWorktreeInstructionDispatcher({
    organizationId: organizationId ?? null,
    currentCloudAgentSessionId: cloudAgentSessionId,
    onSendInstruction,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    target: WorktreeBranchOperationTarget;
    instruction: string;
  } | null>(null);
  const [running, setRunning] = useState<'restack' | 'stack' | null>(null);

  const current = stack.find(target => target.worktreeId === worktreeId);
  const root = stack.find(target => target.isRoot);
  const isRoot = current?.isRoot ?? root?.worktreeId === worktreeId;
  const topPr = useMemo(() => {
    const withPr = stack.filter(target => target.prUrl !== null);
    return withPr.sort((a, b) => (b.stackPosition ?? 0) - (a.stackPosition ?? 0))[0] ?? null;
  }, [stack]);

  const sendConflictText = useCallback(
    async (target: WorktreeBranchOperationTarget, instruction: string) => {
      const sent = await dispatchInstruction(target, instruction);
      if (sent !== 'sent') {
        setConflict({ target, instruction });
        setMessage('The conflict instruction was not sent. Review it and try again.');
        return;
      }
      setConflict(null);
      setMessage('The agent is resolving the conflict.');
    },
    [dispatchInstruction]
  );

  const sendConflictToAgent = useCallback(
    async (target: WorktreeBranchOperationTarget, result: WorktreeBranchOperationResult) => {
      await sendConflictText(target, buildBranchConflictInstruction(target, result));
    },
    [sendConflictText]
  );

  const finish = useCallback(
    async (result: WorktreeBranchOperationResult, target: WorktreeBranchOperationTarget) => {
      if (result.status === 'conflict') {
        setMessage('The branch operation stopped on a conflict.');
        await sendConflictToAgent(target, result);
        return;
      }
      setMessage(operationMessage(result));
    },
    [sendConflictToAgent]
  );

  const handleRestack = async () => {
    setRunning('restack');
    setMessage(null);
    try {
      const target = current ?? {
        worktreeId,
        cloudAgentSessionId,
        branch,
        baseBranch,
        label: branch ?? 'this workspace',
        prNumber: null,
        prState: null,
        prUrl: null,
        stackNumber: null,
        stackPosition: 0,
        isRoot,
      };
      const result = await operations.restack(target);
      await finish(result, target);
    } finally {
      setRunning(null);
    }
  };

  const handleRestackStack = async () => {
    setRunning('stack');
    setMessage(null);
    try {
      const { results, stopped } = await operations.restackStack(stack);
      if (stopped) {
        if (stopped.result.status === 'conflict') {
          await finish(stopped.result, stopped.target);
        } else if (stopped.result.operation === 'sync') {
          setMessage(
            'The restack stopped because the server only synced this layer. Retry Restack to verify the branch.'
          );
        } else {
          setMessage(
            'message' in stopped.result
              ? stopped.result.message
              : 'The restack stack stopped before every layer was applied.'
          );
        }
        return;
      }
      const changed = results.filter(step => step.result.status === 'changed').length;
      setMessage(
        changed > 0
          ? `Restacked ${changed} ${changed === 1 ? 'layer' : 'layers'}.`
          : 'Every layer was already up to date.'
      );
    } finally {
      setRunning(null);
    }
  };

  const busy = running !== null || operations.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Branch operations</DialogTitle>
          <DialogDescription>
            Restack the branch in its own sandbox. This may wake the sandbox and take a few minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Branch:</span>{' '}
              <code className="font-mono">{branch ?? 'unknown'}</code>
            </p>
            {baseBranch && (
              <p>
                <span className="text-muted-foreground">Base:</span>{' '}
                <code className="font-mono">{baseBranch}</code>
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {isRoot && stack.length > 1 && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void handleRestackStack()}
              >
                {running === 'stack' ? (
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <GitMerge className="size-4" />
                )}
                Restack stack
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void handleRestack()}
            >
              {running === 'restack' ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <GitMerge className="size-4" />
              )}
              Restack
            </Button>
            {topPr?.prUrl?.includes('github.com') && (
              <Button asChild variant="ghost">
                <a href={topPr.prUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Rebase on GitHub
                </a>
              </Button>
            )}
          </div>

          {message && (
            <p role="status" className="text-muted-foreground text-sm">
              {message}
            </p>
          )}

          {conflict && (
            <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4" /> Conflict
              </p>
              <p className="text-muted-foreground whitespace-pre-wrap">{conflict.instruction}</p>
              <Button
                type="button"
                size="sm"
                onClick={() => void sendConflictText(conflict.target, conflict.instruction)}
              >
                Send to agent
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
