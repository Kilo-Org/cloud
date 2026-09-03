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
import { deleteWorktree } from './router/handlers/worktree-deletion.js';
import { getSandboxSelectionOptions } from './router/handlers/sandbox-selection.js';

export const appRouter = router({
  deleteWorktree,
  getSandboxSelectionOptions,
  ...createSessionManagementHandlers(),
  ...createSessionPrepareHandlers(),
  ...createSessionExecutionV2Handlers(),
  ...createSessionQuestionHandlers(),
  ...createSessionTerminalHandlers(),
  ...createSessionStartHandlers(),
  ...createSessionSendHandlers(),
  ...createSessionWorktreeHandlers(),
});

export type AppRouter = typeof appRouter;
