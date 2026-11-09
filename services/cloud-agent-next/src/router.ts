/**
 * tRPC Router - Main entry point
 *
 * This is a slim orchestrator that combines handler modules.
 * Handler implementations are in ./router/handlers/
 */
import { router } from './router/auth.js';
import { createSessionManagementHandlers } from './router/handlers/session-management.js';
import { createSessionPrepareHandlers } from './router/handlers/session-prepare.js';
import { createSessionExecutionV2Handlers } from './router/handlers/session-execution.js';
import { createSessionQuestionHandlers } from './router/handlers/session-questions.js';
import { createSessionTerminalHandlers } from './router/handlers/session-terminal.js';
import { createSessionStartHandlers } from './router/handlers/session-start.js';
import { createSessionSendHandlers } from './router/handlers/session-send.js';
import { createSessionWorktreeHandlers } from './router/handlers/session-worktree.js';
import { createSessionRecoveryHandlers } from './router/handlers/session-recovery.js';
import { createHostedWorkspaceMutationHandlers } from './router/handlers/hosted-workspace-mutations.js';
import { createHostedWorkspaceProfileHandlers } from './router/handlers/hosted-workspace-profiles.js';
import { createHostedWorkspaceContinuationHandlers } from './router/handlers/hosted-workspace-continuation.js';
import { deleteWorktree } from './router/handlers/worktree-deletion.js';
import { createSessionWorktreeChangesHandlers } from './router/handlers/session-worktree-changes.js';
import { createSessionEgressAuditHandlers } from './router/handlers/session-egress-audit.js';
import { listChildSessions } from './router/handlers/list-child-sessions.js';
import { createSessionWorktreeGitHandlers } from './router/handlers/session-worktree-git.js';
import { getSandboxSelectionOptions } from './router/handlers/sandbox-selection.js';
import { getPreviewOptions } from './router/handlers/preview-options.js';
import { listPreviewServices } from './router/handlers/preview-services.js';
import { listHostedSessions } from './router/handlers/hosted-session-list.js';
import {
  getHostedWorkspace,
  listHostedWorkspaces,
} from './router/handlers/hosted-workspace-list.js';
import { getHostedWorkspaceStatus } from './router/handlers/hosted-workspace-status.js';
import {
  buildEnvironment,
  cancelEnvironmentBuild,
  getEnvironmentBuildLogs,
  getEnvironmentBuildStatus,
  notifyEnvironmentDeleted,
} from './router/handlers/environment-build.js';
import { getSessionMessagesPage } from './router/handlers/session-history.js';

export const appRouter = router({
  getSessionMessagesPage,
  deleteWorktree,
  getSandboxSelectionOptions,
  getPreviewOptions,
  listPreviewServices,
  listHostedSessions,
  listChildSessions,
  listHostedWorkspaces,
  getHostedWorkspace,
  getHostedWorkspaceStatus,
  buildEnvironment,
  getEnvironmentBuildStatus,
  getEnvironmentBuildLogs,
  cancelEnvironmentBuild,
  notifyEnvironmentDeleted,
  ...createSessionManagementHandlers(),
  ...createSessionPrepareHandlers(),
  ...createSessionExecutionV2Handlers(),
  ...createSessionQuestionHandlers(),
  ...createSessionTerminalHandlers(),
  ...createSessionStartHandlers(),
  ...createSessionSendHandlers(),
  ...createSessionWorktreeHandlers(),
  ...createSessionRecoveryHandlers(),
  ...createHostedWorkspaceMutationHandlers(),
  ...createHostedWorkspaceProfileHandlers(),
  ...createHostedWorkspaceContinuationHandlers(),
  ...createSessionWorktreeChangesHandlers(),
  ...createSessionEgressAuditHandlers(),
  ...createSessionWorktreeGitHandlers(),
});

export type AppRouter = typeof appRouter;
