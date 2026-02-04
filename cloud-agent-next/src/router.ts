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

export const appRouter = router({
  ...createSessionManagementHandlers(),
  ...createSessionPrepareHandlers(),
  ...createSessionExecutionV2Handlers(),
});

export type AppRouter = typeof appRouter;
