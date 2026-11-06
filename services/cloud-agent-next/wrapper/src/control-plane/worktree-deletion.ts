import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import type {
  ControlPlaneWorktreeDeletionRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  deleteWorktree,
  prepareWorktreeDeletion,
  type WorktreeCleanupDeps,
  type WorktreeKiloCleanupClient,
} from '../control/delete-worktree.js';

export type ControlPlaneWorktreeDeletionDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** Live Kilo cleanup clients for one directory (spec §10). */
  clients: (directory: string) => WorktreeKiloCleanupClient[];
  /** Stops and removes every Kilo runtime serving the directory. */
  retireDirectory: (directory: string) => Promise<void>;
  detachRoot?: (kiloSessionId: string) => void;
  detachTerminals?: (directory: string) => Promise<void>;
  onDiagnostic?: ControlDiagnosticReporter;
  log?: (message: string) => void;
};

/**
 * Handles the Sandbox DO's worktree-deletion requests inside the control-plane
 * wrapper (R2, spec §6 "Billing, credentials and deletion"). The cleanup itself
 * is the shared `control/delete-worktree.ts`, unchanged; this adapter owns the
 * frame in/out and answers each request with the shared `worktree.result` frame.
 * A failure reports `not_ready` and retryable, so the Sandbox DO reports the
 * deletion incomplete rather than trusting an unconfirmed cleanup.
 */
export function createControlPlaneWorktreeDeletion(deps: ControlPlaneWorktreeDeletionDeps): {
  handle(frame: ControlPlaneWorktreeDeletionRequestFrame): Promise<void>;
} {
  async function handle(frame: ControlPlaneWorktreeDeletionRequestFrame): Promise<void> {
    try {
      const cleanup: WorktreeCleanupDeps = {
        clients: deps.clients(frame.payload.directory),
        retireDirectory: deps.retireDirectory,
        ...(deps.detachRoot ? { detachRoot: deps.detachRoot } : {}),
        ...(deps.detachTerminals ? { detachTerminals: deps.detachTerminals } : {}),
        ...(deps.onDiagnostic ? { onDiagnostic: deps.onDiagnostic } : {}),
      };
      const result =
        frame.type === 'worktree.prepareDeletion'
          ? {
              prepared: true as const,
              sessionIds: await prepareWorktreeDeletion(frame.payload, cleanup),
            }
          : await deleteWorktree(frame.payload, cleanup);
      deps.emit({ type: 'worktree.result', requestId: frame.requestId, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Worktree cleanup is incomplete';
      deps.log?.(`worktree deletion failed: ${message}`);
      deps.emit({
        type: 'worktree.result',
        requestId: frame.requestId,
        ok: false,
        error: { code: 'not_ready', message: message.slice(0, 4096), retryable: true },
      });
    }
  }

  return { handle };
}
