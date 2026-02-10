/**
 * HTTP Server for the long-running wrapper.
 *
 * Exposes the wrapper's HTTP API for the Worker to interact with:
 * - GET /health - Health check
 * - GET /job/status - Current job status
 * - POST /job/start - Start a new job
 * - POST /job/prompt - Send a prompt
 * - POST /job/command - Send a command
 * - POST /job/answer-permission - Answer a permission request
 * - POST /job/answer-question - Answer a question
 * - POST /job/reject-question - Reject a question
 * - POST /job/abort - Abort the current job
 */

import type { WrapperState, JobContext } from './state.js';
import type { KiloClient } from './kilo-client.js';
import { logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerConfig = {
  port: number;
  kiloServerPort: number;
  workspacePath: string;
  version: string;
};

export type ServerDependencies = {
  state: WrapperState;
  kiloClient: KiloClient;
  openConnection: () => Promise<void>;
  getMaxRuntimeMs: () => number;
  /** Set the aborted flag to skip post-completion tasks */
  setAborted: () => void;
};

// Request body types
type StartJobBody = {
  executionId: string;
  ingestUrl: string;
  ingestToken: string;
  sessionId: string;
  userId: string;
  kilocodeToken: string;
  kiloSessionId?: string;
  kiloSessionTitle?: string;
};

type PromptBody = {
  prompt?: string;
  /** Message parts - only text parts are supported (file parts require URL upload which isn't implemented) */
  parts?: Array<{ type: 'text'; text: string }>;
  model?: { providerID?: string; modelID: string };
  agent?: string;
  messageId?: string;
  system?: string;
  tools?: Record<string, boolean>;
};

type CommandBody = {
  command: string;
  args?: string;
};

type AnswerPermissionBody = {
  permissionId: string;
  response: 'always' | 'once' | 'reject';
};

type AnswerQuestionBody = {
  questionId: string;
  answers: string[];
};

type RejectQuestionBody = {
  questionId: string;
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(error: string, message: string, status: number): Response {
  return jsonResponse({ error, message }, status);
}

/**
 * Validate required string fields on a request body.
 * Returns array of missing field names.
 */
function getMissingFields<T extends Record<string, unknown>>(
  body: T,
  requiredFields: readonly (keyof T)[]
): string[] {
  return requiredFields.filter(field => !body[field]) as string[];
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

function createHealthHandler(config: ServerConfig, state: WrapperState) {
  return (): Response => {
    return jsonResponse({
      healthy: true,
      state: state.isActive ? 'active' : 'idle',
      inflightCount: state.inflightCount,
      version: config.version,
    });
  };
}

function createStatusHandler(state: WrapperState) {
  return (): Response => {
    return jsonResponse(state.getStatus());
  };
}

function createStartJobHandler(deps: ServerDependencies, kiloClient: KiloClient) {
  return async (req: Request): Promise<Response> => {
    const { state } = deps;

    let body: StartJobBody;
    try {
      body = (await req.json()) as StartJobBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    // Validate required fields
    const requiredFields = [
      'executionId',
      'ingestUrl',
      'ingestToken',
      'sessionId',
      'userId',
      'kilocodeToken',
    ] as const;
    const missing = getMissingFields(body, requiredFields);
    if (missing.length > 0) {
      return errorResponse(
        'INVALID_REQUEST',
        `Missing required fields: ${missing.join(', ')}`,
        400
      );
    }

    // Check for idempotent call (same executionId)
    const currentJob = state.currentJob;
    if (currentJob && currentJob.executionId === body.executionId) {
      logToFile(`job/start: idempotent call for executionId=${body.executionId}`);
      return jsonResponse({
        status: 'started',
        kiloSessionId: currentJob.kiloSessionId,
      });
    }

    // Check for conflict (different executionId while active)
    if (currentJob && state.isActive) {
      logToFile(
        `job/start: conflict - active execution ${currentJob.executionId}, requested ${body.executionId}`
      );
      return errorResponse(
        'JOB_CONFLICT',
        `Cannot start new job while execution ${currentJob.executionId} is active`,
        409
      );
    }

    // Create or resume kilo session
    let kiloSessionId: string;
    try {
      if (body.kiloSessionId) {
        // Resume existing session - verify it exists
        await kiloClient.getSession(body.kiloSessionId);
        kiloSessionId = body.kiloSessionId;
        logToFile(`job/start: resuming kilo session ${kiloSessionId}`);
      } else {
        // Create new session
        const session = await kiloClient.createSession({
          title: body.kiloSessionTitle,
        });
        kiloSessionId = session.id;
        logToFile(`job/start: created kilo session ${kiloSessionId}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/start: failed to create/resume session: ${msg}`);
      return errorResponse('SESSION_ERROR', `Failed to create/resume kilo session: ${msg}`, 500);
    }

    // Build job context
    const jobContext: JobContext = {
      executionId: body.executionId,
      sessionId: body.sessionId,
      userId: body.userId,
      kiloSessionId,
      ingestUrl: body.ingestUrl,
      ingestToken: body.ingestToken,
      kilocodeToken: body.kilocodeToken,
    };

    // Start the job (this stores context but doesn't connect yet)
    try {
      state.startJob(jobContext);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/start: state.startJob failed: ${msg}`);
      return errorResponse('JOB_CONFLICT', msg, 409);
    }

    logToFile(
      `job/start: job started executionId=${body.executionId} kiloSessionId=${kiloSessionId}`
    );
    return jsonResponse({ status: 'started', kiloSessionId });
  };
}

function createPromptHandler(deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient, openConnection, getMaxRuntimeMs } = deps;

    const job = state.currentJob;
    if (!job) {
      return errorResponse('NO_JOB', 'Call /job/start first', 400);
    }

    let body: PromptBody;
    try {
      body = (await req.json()) as PromptBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    // Validate prompt content
    if (!body.prompt && !body.parts) {
      return errorResponse('INVALID_REQUEST', 'Either prompt or parts is required', 400);
    }
    const messageId = body.messageId ?? state.nextMessageId();

    // Open connection if idle
    if (state.isIdle && !state.isConnected) {
      try {
        await openConnection();
        logToFile(`job/prompt: connection opened`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`job/prompt: failed to open connection: ${msg}`);
        return errorResponse('CONNECTION_ERROR', `Failed to open connection: ${msg}`, 500);
      }
    }

    // Calculate deadline
    const deadline = Date.now() + getMaxRuntimeMs();

    // Track inflight
    state.addInflight(messageId, deadline);

    // Send to kilo server with the messageId we're tracking
    try {
      await kiloClient.sendPromptAsync({
        sessionId: job.kiloSessionId,
        parts: body.parts,
        prompt: body.prompt,
        agent: body.agent,
        model: body.model,
        system: body.system,
        tools: body.tools,
      });
      logToFile(`job/prompt: sent messageId=${messageId}`);
    } catch (error) {
      // Remove from inflight on failure
      state.removeInflight(messageId);
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/prompt: failed to send: ${msg}`);
      return errorResponse('SEND_ERROR', `Failed to send prompt: ${msg}`, 500);
    }

    return jsonResponse({ status: 'sent', messageId });
  };
}

function createCommandHandler(deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient } = deps;

    const job = state.currentJob;
    if (!job) {
      return errorResponse('NO_JOB', 'Call /job/start first', 400);
    }

    let body: CommandBody;
    try {
      body = (await req.json()) as CommandBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    if (!body.command) {
      return errorResponse('INVALID_REQUEST', 'command is required', 400);
    }

    // Commands are synchronous - call kilo server directly
    // Note: Commands do NOT open connection or track inflight
    try {
      const result = await kiloClient.sendCommand({
        sessionId: job.kiloSessionId,
        command: body.command,
        args: body.args,
      });
      state.updateActivity();
      logToFile(`job/command: sent command=${body.command}`);
      return jsonResponse({ status: 'sent', result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/command: failed: ${msg}`);
      return errorResponse('COMMAND_ERROR', `Failed to send command: ${msg}`, 500);
    }
  };
}

function createAnswerPermissionHandler(deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient } = deps;

    if (!state.hasJob) {
      return errorResponse('NO_JOB', 'Call /job/start first', 400);
    }

    let body: AnswerPermissionBody;
    try {
      body = (await req.json()) as AnswerPermissionBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    if (!body.permissionId || !body.response) {
      return errorResponse('INVALID_REQUEST', 'permissionId and response are required', 400);
    }

    try {
      const success = await kiloClient.answerPermission(body.permissionId, body.response);
      state.updateActivity();
      logToFile(
        `job/answer-permission: permissionId=${body.permissionId} response=${body.response}`
      );
      return jsonResponse({ status: 'answered', success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/answer-permission: failed: ${msg}`);
      return errorResponse('PERMISSION_ERROR', `Failed to answer permission: ${msg}`, 500);
    }
  };
}

function createAnswerQuestionHandler(deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient } = deps;

    if (!state.hasJob) {
      return errorResponse('NO_JOB', 'Call /job/start first', 400);
    }

    let body: AnswerQuestionBody;
    try {
      body = (await req.json()) as AnswerQuestionBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    if (!body.questionId || !body.answers) {
      return errorResponse('INVALID_REQUEST', 'questionId and answers are required', 400);
    }

    try {
      const success = await kiloClient.answerQuestion(body.questionId, body.answers);
      state.updateActivity();
      logToFile(`job/answer-question: questionId=${body.questionId}`);
      return jsonResponse({ status: 'answered', success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/answer-question: failed: ${msg}`);
      return errorResponse('QUESTION_ERROR', `Failed to answer question: ${msg}`, 500);
    }
  };
}

function createRejectQuestionHandler(deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient } = deps;

    if (!state.hasJob) {
      return errorResponse('NO_JOB', 'Call /job/start first', 400);
    }

    let body: RejectQuestionBody;
    try {
      body = (await req.json()) as RejectQuestionBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    if (!body.questionId) {
      return errorResponse('INVALID_REQUEST', 'questionId is required', 400);
    }

    try {
      const success = await kiloClient.rejectQuestion(body.questionId);
      state.updateActivity();
      logToFile(`job/reject-question: questionId=${body.questionId}`);
      return jsonResponse({ status: 'rejected', success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/reject-question: failed: ${msg}`);
      return errorResponse('QUESTION_ERROR', `Failed to reject question: ${msg}`, 500);
    }
  };
}

function createAbortHandler(deps: ServerDependencies, triggerDrainAndClose: () => void) {
  return async (_req: Request): Promise<Response> => {
    const { state, kiloClient, setAborted } = deps;

    const job = state.currentJob;
    if (!job) {
      return errorResponse('NO_JOB', 'No active job to abort', 400);
    }

    // Set aborted flag FIRST to prevent post-completion tasks from running
    setAborted();

    // Abort the kilo session
    try {
      await kiloClient.abortSession({ sessionId: job.kiloSessionId });
      logToFile(`job/abort: aborted kilo session ${job.kiloSessionId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/abort: abort request failed (continuing): ${msg}`);
    }

    // Send abort event to ingest
    state.sendToIngest({
      streamEventType: 'interrupted',
      data: { reason: 'aborted via API' },
      timestamp: new Date().toISOString(),
    });

    // Clear inflight and trigger close
    state.clearAllInflight();
    triggerDrainAndClose();

    return jsonResponse({ status: 'aborted' });
  };
}

// ---------------------------------------------------------------------------
// Server Creation
// ---------------------------------------------------------------------------

export type WrapperServer = {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
};

export function createServer(
  config: ServerConfig,
  deps: ServerDependencies,
  triggerDrainAndClose: () => void
): WrapperServer {
  const { state, kiloClient } = deps;

  // Create route handlers
  const healthHandler = createHealthHandler(config, state);
  const statusHandler = createStatusHandler(state);
  const startJobHandler = createStartJobHandler(deps, kiloClient);
  const promptHandler = createPromptHandler(deps);
  const commandHandler = createCommandHandler(deps);
  const answerPermissionHandler = createAnswerPermissionHandler(deps);
  const answerQuestionHandler = createAnswerQuestionHandler(deps);
  const rejectQuestionHandler = createRejectQuestionHandler(deps);
  const abortHandler = createAbortHandler(deps, triggerDrainAndClose);

  // Route table
  type RouteHandler = (req: Request) => Response | Promise<Response>;
  const routes: Record<string, Record<string, RouteHandler>> = {
    GET: {
      '/health': healthHandler,
      '/job/status': statusHandler,
    },
    POST: {
      '/job/start': startJobHandler,
      '/job/prompt': promptHandler,
      '/job/command': commandHandler,
      '/job/answer-permission': answerPermissionHandler,
      '/job/answer-question': answerQuestionHandler,
      '/job/reject-question': rejectQuestionHandler,
      '/job/abort': abortHandler,
    },
  };

  const server = Bun.serve({
    port: config.port,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      logToFile(`HTTP ${method} ${path}`);

      // Look up route
      const methodRoutes = routes[method];
      if (!methodRoutes) {
        return errorResponse('METHOD_NOT_ALLOWED', `Method ${method} not allowed`, 405);
      }

      const handler = methodRoutes[path];
      if (!handler) {
        return errorResponse('NOT_FOUND', `Path ${path} not found`, 404);
      }

      try {
        return await handler(req);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`HTTP handler error: ${msg}`);
        return errorResponse('INTERNAL_ERROR', msg, 500);
      }
    },
  });

  logToFile(`HTTP server listening on port ${config.port}`);

  return {
    server,
    stop: async () => {
      await server.stop();
      logToFile('HTTP server stopped');
    },
  };
}
