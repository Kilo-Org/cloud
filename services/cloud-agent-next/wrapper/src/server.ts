/**
 * HTTP Server for the long-running wrapper.
 *
 * Exposes the wrapper's HTTP API for the Worker to interact with:
 * - GET /health - Health check (includes sessionId)
 * - GET /job/status - Current job status
 * - POST /job/prompt - Send a prompt (includes execution binding)
 * - POST /job/command - Send a command (includes execution binding)
 * - POST /job/answer-permission - Answer a permission request
 * - POST /job/answer-question - Answer a question
 * - POST /job/reject-question - Reject a question
 * - POST /job/abort - Abort the current job
 */

import type { WrapperState, JobContext } from './state.js';
import type { WrapperKiloClient, WrapperPtySize } from './kilo-api.js';
import type { PerTurnConfig } from './lifecycle.js';
import { createLogUploader } from './log-uploader.js';
import { logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerConfig = {
  port: number;
  workspacePath: string;
  version: string;
  /** The root kilo session ID, created at wrapper startup */
  sessionId: string;
  /** Stable Cloud Agent session ID, passed at wrapper startup */
  agentSessionId: string;
  /** Stable Cloud Agent user ID, passed at wrapper startup */
  userId: string;
  /** Product surface that created the session, e.g. code-review. */
  platform?: string;
};

export type ServerDependencies = {
  state: WrapperState;
  kiloClient: WrapperKiloClient;
  openConnection: () => Promise<void>;
  /** Close existing connections (ingest WS + event subscription) */
  closeConnection: () => Promise<void>;
  /** Set the aborted flag to skip post-completion tasks */
  setAborted: () => void;
  /** Reset lifecycle state for a new execution */
  resetLifecycle: () => void;
  /** Set per-turn config on the lifecycle manager */
  setPerTurnConfig: (config: PerTurnConfig) => void;
};

/**
 * Per-execution config, included in prompt/command bodies.
 * A new executionId triggers setup (log uploader, state reset).
 * Same executionId is idempotent. Omitted means use existing context.
 */
type ExecutionBinding = {
  executionId: string;
  ingestUrl: string;
  ingestToken: string;
  workerAuthToken: string;
  upstreamBranch?: string;
};

type PromptBody = {
  prompt?: string;
  /** Message parts - text or file (with local file:// URL) */
  parts?: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }
  >;
  model?: { providerID?: string; modelID: string };
  variant?: string;
  agent?: string;
  messageId?: string;
  system?: string;
  tools?: Record<string, boolean>;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Per-execution config — new executionId triggers setup */
  execution?: ExecutionBinding;
};

type CommandBody = {
  command: string;
  args?: string;
  messageId?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Per-execution config — new executionId triggers setup */
  execution?: ExecutionBinding;
};

type AnswerPermissionBody = {
  permissionId: string;
  response: 'always' | 'once' | 'reject';
  message?: string;
};

type AnswerQuestionBody = {
  questionId: string;
  answers: string[][];
};

type RejectQuestionBody = {
  questionId: string;
};

type PtyCreateBody = {
  cols?: number;
  rows?: number;
};

type PtyResizeBody = {
  cols?: number;
  rows?: number;
  size?: {
    cols?: number;
    rows?: number;
  };
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

const PTY_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MIN_PTY_COLS = 2;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 2;
const MAX_PTY_ROWS = 200;
const WORKSPACE_TERMINAL_ENV = {
  // Shell startup files may replace inherited PS1, so reapply it before each prompt.
  PROMPT_COMMAND: "PS1='\\n\\W\\n\\$ '",
  PS1: '\\n\\W\\n\\$ ',
} satisfies Record<string, string>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(error: string, message: string, status: number): Response {
  return jsonResponse({ error, message }, status);
}

async function readJsonBody<T>(req: Request, defaultValue: T): Promise<T> {
  const text = await req.text();
  if (!text.trim()) return defaultValue;
  return JSON.parse(text) as T;
}

function validatePtyId(ptyId: string | undefined): string | null {
  if (!ptyId || !PTY_ID_RE.test(ptyId)) return null;
  return ptyId;
}

function parsePtySize(input: PtyCreateBody | PtyResizeBody): WrapperPtySize | null {
  const rows = 'size' in input && input.size ? input.size.rows : input.rows;
  const cols = 'size' in input && input.size ? input.size.cols : input.cols;

  if (rows === undefined && cols === undefined) return null;

  if (
    typeof rows !== 'number' ||
    typeof cols !== 'number' ||
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < MIN_PTY_ROWS ||
    rows > MAX_PTY_ROWS ||
    cols < MIN_PTY_COLS ||
    cols > MAX_PTY_COLS
  ) {
    throw new Error(
      `PTY size must include integer cols ${MIN_PTY_COLS}-${MAX_PTY_COLS} and rows ${MIN_PTY_ROWS}-${MAX_PTY_ROWS}`
    );
  }

  return { cols, rows };
}

function parsePtyPath(path: string): { ptyId: string; action?: 'connect' } | null {
  const match = path.match(/^\/pty\/([^/]+)(?:\/(connect))?$/);
  if (!match) return null;

  const ptyId = validatePtyId(match[1]);
  if (!ptyId) return null;

  return {
    ptyId,
    action: match[2] === 'connect' ? 'connect' : undefined,
  };
}

/**
 * Bind execution context from a prompt/command body.
 *
 * - If `execution` present with a new `executionId`: run setup (store context,
 *   create log uploader, reset lifecycle).
 * - If same `executionId`: no-op (idempotent).
 * - If `execution` omitted: use existing job context (for follow-up calls
 *   like answer-question).
 *
 * Returns an error Response if binding fails, or null on success.
 */
async function bindExecutionContext(
  execution: ExecutionBinding | undefined,
  config: ServerConfig,
  deps: ServerDependencies
): Promise<Response | null> {
  const { state } = deps;

  if (!execution) {
    // No execution binding — use existing context
    if (!state.hasJob) {
      return errorResponse('NO_JOB', 'No execution context and no execution binding provided', 400);
    }
    return null;
  }

  // Idempotent: same executionId
  const currentJob = state.currentJob;
  if (currentJob && currentJob.executionId === execution.executionId) {
    return null;
  }

  // Conflict: different executionId while active
  if (currentJob && state.isActive) {
    logToFile(
      `execution binding conflict: active=${currentJob.executionId} requested=${execution.executionId}`
    );
    return errorResponse(
      'JOB_CONFLICT',
      `Cannot bind new execution while execution ${currentJob.executionId} is active`,
      409
    );
  }

  // Parse ingest URL to derive worker base URL for log uploads
  let workerBaseUrl: string;
  try {
    const ingestOrigin = new URL(execution.ingestUrl);
    ingestOrigin.protocol =
      ingestOrigin.protocol === 'wss:' || ingestOrigin.protocol === 'https:' ? 'https:' : 'http:';
    workerBaseUrl = ingestOrigin.origin;
  } catch {
    return errorResponse('INVALID_REQUEST', 'Invalid ingestUrl', 400);
  }

  // Build job context
  const jobContext: JobContext = {
    executionId: execution.executionId,
    kiloSessionId: config.sessionId,
    ingestUrl: execution.ingestUrl,
    ingestToken: execution.ingestToken,
    workerAuthToken: execution.workerAuthToken,
    platform: config.platform,
  };

  // Close stale ingest connection from the prior execution. The prior execution's
  // 'complete' event was already delivered before the DO allowed this new execution
  // to start, so all A-side events have been flushed — closing now is safe.
  // Await the close to ensure the old event subscription is fully torn down
  // before starting the new job context.
  if (state.isConnected) {
    await deps.closeConnection();
  }

  // Reset lifecycle state from previous execution
  deps.resetLifecycle();

  // Start the job
  try {
    state.startJob(jobContext);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`execution binding failed: ${msg}`);
    return errorResponse('JOB_CONFLICT', msg, 409);
  }

  // Create and start log uploader for this execution
  const cliLogDir = `/home/${config.agentSessionId}/.local/share/kilo/log`;
  const wrapperLogPath = process.env.WRAPPER_LOG_PATH ?? '/tmp/kilocode-wrapper.log';
  const logUploader = createLogUploader({
    workerBaseUrl,
    sessionId: config.agentSessionId,
    executionId: execution.executionId,
    userId: config.userId,
    workerAuthToken: execution.workerAuthToken,
    cliLogDir,
    wrapperLogPath,
  });
  state.setLogUploader(logUploader);
  logUploader.start();
  logToFile(`execution bound: executionId=${execution.executionId} sessionId=${config.sessionId}`);

  return null;
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

function createHealthHandler(config: ServerConfig, state: WrapperState) {
  return (): Response => {
    return jsonResponse({
      healthy: true,
      state: state.isActive ? 'active' : 'idle',
      version: config.version,
      sessionId: config.sessionId,
    });
  };
}

function createStatusHandler(state: WrapperState) {
  return (): Response => {
    return jsonResponse(state.getStatus());
  };
}

function createPromptHandler(config: ServerConfig, deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient, openConnection } = deps;

    let body: PromptBody;
    try {
      body = (await req.json()) as PromptBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    // Bind execution context if provided
    const bindError = await bindExecutionContext(body.execution, config, deps);
    if (bindError) return bindError;

    const job = state.currentJob;
    if (!job) {
      return errorResponse('NO_JOB', 'No execution context available', 400);
    }

    // Validate prompt content
    if (!body.prompt && !body.parts) {
      return errorResponse('INVALID_REQUEST', 'Either prompt or parts is required', 400);
    }
    const messageId = body.messageId;

    // Set per-turn config on the lifecycle manager
    deps.setPerTurnConfig({
      autoCommit: body.autoCommit ?? false,
      condenseOnComplete: body.condenseOnComplete ?? false,
      model: body.model?.modelID,
      upstreamBranch: body.execution?.upstreamBranch,
    });

    // Open connection if idle
    if (state.isIdle && !state.isConnected) {
      try {
        await openConnection();
        logToFile('job/prompt: connection opened');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`job/prompt: failed to open connection: ${msg}`);
        return errorResponse('CONNECTION_ERROR', `Failed to open connection: ${msg}`, 500);
      }
    }

    // Mark active
    state.setActive(true);

    // Send to kilo server
    try {
      await kiloClient.sendPromptAsync({
        sessionId: job.kiloSessionId,
        messageId,
        parts: body.parts,
        prompt: body.prompt,
        variant: body.variant,
        agent: body.agent,
        model: body.model,
        system: body.system,
        tools: body.tools,
      });
      logToFile(
        messageId !== undefined ? `job/prompt: sent messageId=${messageId}` : 'job/prompt: sent'
      );
    } catch (error) {
      state.setActive(false);
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`job/prompt: failed to send: ${msg}`);
      return errorResponse('SEND_ERROR', `Failed to send prompt: ${msg}`, 500);
    }

    return jsonResponse(
      messageId !== undefined ? { status: 'sent', messageId } : { status: 'sent' }
    );
  };
}

function createCommandHandler(config: ServerConfig, deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    const { state, kiloClient, openConnection } = deps;

    let body: CommandBody;
    try {
      body = (await req.json()) as CommandBody;
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    // Bind execution context if provided
    const bindError = await bindExecutionContext(body.execution, config, deps);
    if (bindError) return bindError;

    const job = state.currentJob;
    if (!job) {
      return errorResponse('NO_JOB', 'No execution context available', 400);
    }

    if (!body.command) {
      return errorResponse('INVALID_REQUEST', 'command is required', 400);
    }

    // Slash commands now enter through the same execution lifecycle as prompts
    // (sendMessageV2 with payload.type === 'command'), so they may be the first
    // wrapper interaction for a fresh execution. Mirror /job/prompt's
    // connection + active-state setup so kilo's events flow back via /ingest.
    deps.setPerTurnConfig({
      autoCommit: body.autoCommit ?? false,
      condenseOnComplete: body.condenseOnComplete ?? false,
      upstreamBranch: body.execution?.upstreamBranch,
    });

    if (state.isIdle && !state.isConnected) {
      try {
        await openConnection();
        logToFile('job/command: connection opened');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`job/command: failed to open connection: ${msg}`);
        return errorResponse('CONNECTION_ERROR', `Failed to open connection: ${msg}`, 500);
      }
    }

    state.setActive(true);

    try {
      const result = await kiloClient.sendCommand({
        sessionId: job.kiloSessionId,
        command: body.command,
        args: body.args,
        messageId: body.messageId,
      });
      logToFile(`job/command: sent command=${body.command}`);
      state.setActive(false);
      return jsonResponse({ status: 'sent', result });
    } catch (error) {
      state.setActive(false);
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
      return errorResponse('NO_JOB', 'No execution context', 400);
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
      const success = await kiloClient.answerPermission(
        body.permissionId,
        body.response,
        body.message
      );
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
      return errorResponse('NO_JOB', 'No execution context', 400);
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
      return errorResponse('NO_JOB', 'No execution context', 400);
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

    // Deactivate and trigger close
    state.setActive(false);
    triggerDrainAndClose();

    return jsonResponse({ status: 'aborted' });
  };
}

function createPtyCreateHandler(config: ServerConfig, deps: ServerDependencies) {
  return async (req: Request): Promise<Response> => {
    let body: PtyCreateBody;
    try {
      body = await readJsonBody<PtyCreateBody>(req, {});
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    let size: WrapperPtySize | null;
    try {
      size = parsePtySize(body);
    } catch (error) {
      return errorResponse(
        'INVALID_REQUEST',
        error instanceof Error ? error.message : String(error),
        400
      );
    }

    let createdPtyId: string | null = null;
    try {
      const pty = await deps.kiloClient.createPty({
        cwd: config.workspacePath,
        title: 'Workspace terminal',
        env: WORKSPACE_TERMINAL_ENV,
      });
      createdPtyId = pty.id;
      const sizedPty = size ? await deps.kiloClient.resizePty(pty.id, size) : pty;
      logToFile(`pty/create: ptyId=${pty.id}`);
      return jsonResponse(sizedPty);
    } catch (error) {
      if (createdPtyId) {
        try {
          await deps.kiloClient.deletePty(createdPtyId);
          logToFile(`pty/create: cleaned up ptyId=${createdPtyId}`);
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          logToFile(`pty/create: cleanup failed ptyId=${createdPtyId}: ${cleanupMessage}`);
        }
      }

      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`pty/create: failed: ${msg}`);
      return errorResponse('PTY_ERROR', `Failed to create PTY: ${msg}`, 500);
    }
  };
}

function createPtyResizeHandler(deps: ServerDependencies, ptyId: string) {
  return async (req: Request): Promise<Response> => {
    let body: PtyResizeBody;
    try {
      body = await readJsonBody<PtyResizeBody>(req, {});
    } catch {
      return errorResponse('INVALID_REQUEST', 'Invalid JSON body', 400);
    }

    let size: WrapperPtySize | null;
    try {
      size = parsePtySize(body);
    } catch (error) {
      return errorResponse(
        'INVALID_REQUEST',
        error instanceof Error ? error.message : String(error),
        400
      );
    }

    if (!size) {
      return errorResponse('INVALID_REQUEST', 'PTY size is required', 400);
    }

    try {
      const pty = await deps.kiloClient.resizePty(ptyId, size);
      logToFile(`pty/resize: ptyId=${ptyId} cols=${size.cols} rows=${size.rows}`);
      return jsonResponse(pty);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`pty/resize: failed ptyId=${ptyId}: ${msg}`);
      return errorResponse('PTY_ERROR', `Failed to resize PTY: ${msg}`, 500);
    }
  };
}

function createPtyDeleteHandler(deps: ServerDependencies, ptyId: string) {
  return async (_req: Request): Promise<Response> => {
    try {
      const success = await deps.kiloClient.deletePty(ptyId);
      logToFile(`pty/delete: ptyId=${ptyId}`);
      return jsonResponse({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`pty/delete: failed ptyId=${ptyId}: ${msg}`);
      return errorResponse('PTY_ERROR', `Failed to delete PTY: ${msg}`, 500);
    }
  };
}

function buildPtyUpstreamUrl(
  config: ServerConfig,
  deps: ServerDependencies,
  ptyId: string
): string {
  const upstream = new URL(`/pty/${encodeURIComponent(ptyId)}/connect`, deps.kiloClient.serverUrl);
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  upstream.searchParams.set('directory', config.workspacePath);
  return upstream.toString();
}

type WrapperWebSocketData = {
  ptyId?: string;
};

type PtyClientClose = {
  code: number;
  reason: string;
};

function isForwardableCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1005, 1006, 1015].includes(code)
  );
}

export function resolvePtyClientClose(event: { code: number; reason: string }): PtyClientClose {
  if (event.code === 1000) {
    return { code: 1000, reason: 'PTY session ended' };
  }

  if (isForwardableCloseCode(event.code)) {
    return { code: event.code, reason: event.reason || 'PTY upstream closed' };
  }

  return { code: 1011, reason: event.reason || 'PTY upstream closed' };
}

type BunUpgradeServer = {
  upgrade: (req: Request, options: { data: WrapperWebSocketData }) => boolean;
};

function createWebSocketHandlers(config: ServerConfig, deps: ServerDependencies) {
  const ptyUpstreams = new WeakMap<object, WebSocket>();

  return {
    open(ws: Bun.ServerWebSocket<WrapperWebSocketData>) {
      const ptyId = ws.data.ptyId;
      if (!ptyId) {
        ws.close(1011, 'Missing PTY');
        return;
      }

      const upstream = new WebSocket(buildPtyUpstreamUrl(config, deps, ptyId));
      upstream.binaryType = 'arraybuffer';
      ptyUpstreams.set(ws, upstream);

      upstream.onmessage = event => {
        try {
          ws.send(event.data instanceof ArrayBuffer ? event.data : String(event.data));
        } catch {
          // Client disconnected.
        }
      };
      upstream.onclose = event => {
        const close = resolvePtyClientClose({ code: event.code, reason: event.reason });
        try {
          ws.close(close.code, close.reason);
        } catch {
          // Already closed.
        }
      };
      upstream.onerror = () => {
        try {
          ws.close(1011, 'PTY upstream error');
        } catch {
          // Already closed.
        }
      };
    },
    message(
      ws: Bun.ServerWebSocket<WrapperWebSocketData>,
      message: string | ArrayBuffer | Uint8Array
    ) {
      const upstream = ptyUpstreams.get(ws);
      if (upstream?.readyState === WebSocket.OPEN) {
        if (typeof message === 'string' || message instanceof ArrayBuffer) {
          upstream.send(message);
          return;
        }
        const copy = new Uint8Array(message.byteLength);
        copy.set(message);
        upstream.send(copy.buffer);
      }
    },
    close(ws: Bun.ServerWebSocket<WrapperWebSocketData>) {
      const upstream = ptyUpstreams.get(ws);
      if (upstream) {
        try {
          upstream.close();
        } catch {
          // Already closed.
        }
        ptyUpstreams.delete(ws);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Server Creation
// ---------------------------------------------------------------------------

export type WrapperServer = {
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
};

export function createFetchHandler(
  config: ServerConfig,
  deps: ServerDependencies,
  triggerDrainAndClose: () => void
): (req: Request, server?: BunUpgradeServer) => Response | Promise<Response> | undefined {
  const { state } = deps;

  // Create route handlers
  const healthHandler = createHealthHandler(config, state);
  const statusHandler = createStatusHandler(state);
  const promptHandler = createPromptHandler(config, deps);
  const commandHandler = createCommandHandler(config, deps);
  const answerPermissionHandler = createAnswerPermissionHandler(deps);
  const answerQuestionHandler = createAnswerQuestionHandler(deps);
  const rejectQuestionHandler = createRejectQuestionHandler(deps);
  const abortHandler = createAbortHandler(deps, triggerDrainAndClose);
  const ptyCreateHandler = createPtyCreateHandler(config, deps);

  // Route table
  type RouteHandler = (req: Request) => Response | Promise<Response>;
  const routes: Record<string, Record<string, RouteHandler>> = {
    GET: {
      '/health': healthHandler,
      '/job/status': statusHandler,
    },
    POST: {
      '/job/prompt': promptHandler,
      '/job/command': commandHandler,
      '/job/answer-permission': answerPermissionHandler,
      '/job/answer-question': answerQuestionHandler,
      '/job/reject-question': rejectQuestionHandler,
      '/job/abort': abortHandler,
      '/pty': ptyCreateHandler,
    },
  };

  return (req: Request, server?: BunUpgradeServer): Response | Promise<Response> | undefined => {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    logToFile(`HTTP ${method} ${path}`);

    const ptyPath = parsePtyPath(path);
    if (ptyPath) {
      if (ptyPath.action === 'connect') {
        if (method !== 'GET') {
          return errorResponse('METHOD_NOT_ALLOWED', `Method ${method} not allowed`, 405);
        }
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return errorResponse('UPGRADE_REQUIRED', 'Expected WebSocket upgrade', 426);
        }
        if (!server) {
          return errorResponse('INTERNAL_ERROR', 'WebSocket server unavailable', 500);
        }
        const upgraded = server.upgrade(req, { data: { ptyId: ptyPath.ptyId } });
        if (upgraded) return undefined;
        return errorResponse('UPGRADE_FAILED', 'WebSocket upgrade failed', 400);
      }

      if (method === 'PUT') {
        return createPtyResizeHandler(deps, ptyPath.ptyId)(req);
      }
      if (method === 'DELETE') {
        return createPtyDeleteHandler(deps, ptyPath.ptyId)(req);
      }
    }

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
      return Promise.resolve(handler(req)).catch(error => {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`HTTP handler error: ${msg}`);
        return errorResponse('INTERNAL_ERROR', msg, 500);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`HTTP handler error: ${msg}`);
      return errorResponse('INTERNAL_ERROR', msg, 500);
    }
  };
}

export function createServer(
  config: ServerConfig,
  deps: ServerDependencies,
  triggerDrainAndClose: () => void
): WrapperServer {
  const fetchHandler = createFetchHandler(config, deps, triggerDrainAndClose);
  const websocket = createWebSocketHandlers(config, deps);

  const server = Bun.serve<WrapperWebSocketData>({
    port: config.port,
    fetch: fetchHandler,
    websocket,
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
