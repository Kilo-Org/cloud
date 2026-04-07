/**
 * Supervisor entry point for per-session (standard-2) sandboxes.
 *
 * Runs as the CMD of the /sandbox entrypoint. Boots a minimal HTTP server
 * on :5000 immediately (for health checks), then waits for POST /job/init
 * from the DO before performing workspace setup and starting kilo.
 *
 * State machine:  waiting_for_init → initializing → ready  (or → failed)
 * Once ready, the full runtime handles jobs identically to main.ts.
 */

import { WRAPPER_VERSION } from '../../src/shared/wrapper-version.js';
import type { SupervisorInitPayload } from '../../src/shared/supervisor-protocol.js';
import { logToFile, installCrashHandlers } from './utils.js';
import type { WrapperKiloClient, KiloServerHandle } from './kilo-api.js';
import {
  cloneRepo,
  checkoutBranch,
  runSetupCommands,
  writeAuthFile,
  importSession,
} from './workspace-setup.js';
import {
  initKilo,
  createOrVerifySession,
  createRuntime,
  shutdownRuntime,
  type KiloRuntime,
} from './lib/kilo-runtime.js';
import { createLogUploader } from './log-uploader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SupervisorState = 'waiting_for_init' | 'initializing' | 'ready' | 'failed';

type InitResponse =
  | { status: 'ready'; kiloSessionId: string }
  | { status: 'error'; step: string; message: string };

type InitStep = 'clone' | 'branch' | 'ref' | 'setup' | 'auth' | 'import' | 'kilo';

type InitSuccess = {
  ok: true;
  kiloSessionId: string;
  kiloClient: WrapperKiloClient;
  kiloServer: KiloServerHandle;
};

type InitFailure = {
  ok: false;
  step: InitStep;
  message: string;
};

type InitResult = InitSuccess | InitFailure;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WRAPPER_PORT = 5000;

/** How long the supervisor waits idle before shutting down (15 min) */
const SUPERVISOR_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Abort execution if no kilo events for this long (2 min) */
const ACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

/** Hard limit on a single turn's wall-clock duration (30 min) */
const MAX_TURN_RUNTIME_MS = 30 * 60 * 1000;

/** How often to check for activity timeout (30s) */
const ACTIVITY_CHECK_INTERVAL_MS = 30 * 1000;

/** Hard timeout for the entire /job/init handler (5 min) */
const INIT_TIMEOUT_MS = 5 * 60 * 1000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Init handler — performs workspace setup + kilo startup
// ---------------------------------------------------------------------------

async function handleInit(body: SupervisorInitPayload): Promise<InitResult> {
  // Set env vars from the request
  if (body.env) {
    for (const [key, value] of Object.entries(body.env)) {
      process.env[key] = value;
    }
  }

  // 1. Clone repo
  try {
    await cloneRepo({
      url: body.repo.url,
      targetDir: body.workspacePath,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`[supervisor] clone failed: ${msg}`);
    return { ok: false, step: 'clone', message: msg };
  }

  // 2. Checkout branch (if specified)
  if (body.repo.branch) {
    try {
      await checkoutBranch({
        workspacePath: body.workspacePath,
        branchName: body.repo.branch,
        isUpstreamBranch: !!body.repo.ref,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`[supervisor] branch checkout failed: ${msg}`);
      return { ok: false, step: 'branch', message: msg };
    }
  }

  // 3. Checkout specific commit ref (if specified)
  if (body.repo.ref) {
    try {
      const proc = Bun.spawn(['git', 'checkout', body.repo.ref], {
        cwd: body.workspacePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `git checkout ${body.repo.ref} failed (exit ${exitCode}): ${stderr.trim()}`
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`[supervisor] ref checkout failed: ${msg}`);
      return { ok: false, step: 'ref', message: msg };
    }
  }

  // 4. Run setup commands
  if (body.setupCommands && body.setupCommands.length > 0) {
    try {
      await runSetupCommands({
        workspacePath: body.workspacePath,
        commands: body.setupCommands,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`[supervisor] setup commands failed: ${msg}`);
      return { ok: false, step: 'setup', message: msg };
    }
  }

  // 5. Write auth file
  if (body.auth?.kilocodeToken) {
    try {
      writeAuthFile({
        sessionHome: body.sessionHome,
        kilocodeToken: body.auth.kilocodeToken,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`[supervisor] auth file write failed: ${msg}`);
      return { ok: false, step: 'auth', message: msg };
    }
  }

  // 6. Import session (if specified)
  if (body.sessionImport) {
    try {
      await importSession({
        kiloSessionId: body.sessionImport.kiloSessionId,
        workspacePath: body.workspacePath,
        snapshotUrl: body.sessionImport.snapshotUrl,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logToFile(`[supervisor] session import failed: ${msg}`);
      return { ok: false, step: 'import', message: msg };
    }
  }

  // 7. Set working directory for kilo
  process.chdir(body.workspacePath);

  // 8. Start kilo server
  let kiloClient: WrapperKiloClient;
  let kiloServer: KiloServerHandle;
  try {
    const kiloInit = await initKilo();
    kiloClient = kiloInit.kiloClient;
    kiloServer = kiloInit.kiloServer;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`[supervisor] kilo init failed: ${msg}`);
    return { ok: false, step: 'kilo', message: msg };
  }

  // 9. Create/verify session
  let kiloSessionId: string;
  try {
    kiloSessionId = await createOrVerifySession(kiloClient, body.sessionImport?.kiloSessionId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`[supervisor] session create/verify failed: ${msg}`);
    return { ok: false, step: 'kilo', message: msg };
  }

  return { ok: true, kiloSessionId, kiloClient, kiloServer };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Set log path early
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${Date.now()}.log`;
  }

  logToFile(`[supervisor] starting bun=${Bun.version} version=${WRAPPER_VERSION}`);

  let supervisorState: SupervisorState = 'waiting_for_init';
  let cachedInitResponse: InitResponse | undefined;
  // Late-bound: closures (signal handlers, watchdogs) capture by reference
  // before runtime is assigned after createRuntime() below.
  // eslint-disable-next-line prefer-const
  let runtime: KiloRuntime | undefined;

  // Context passed from /job/init handler to phase 2 wiring
  type InitContext = {
    body: SupervisorInitPayload;
    kiloSessionId: string;
    kiloClient: WrapperKiloClient;
    kiloServer: KiloServerHandle;
  };
  let initContext: InitContext | undefined;

  // Resolved once /job/init completes, allowing main() to proceed to phase 2.
  let resolveInitDone: () => void;
  const initDone = new Promise<void>(resolve => {
    resolveInitDone = resolve;
  });

  // ------------------------------------------------------------------
  // Phase 1: Bare HTTP server (health + /job/init only)
  // ------------------------------------------------------------------

  const bareServer = Bun.serve({
    port: WRAPPER_PORT,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      logToFile(`[supervisor] HTTP ${method} ${path}`);

      if (method === 'GET' && path === '/health') {
        return jsonResponse({
          healthy: true,
          state: supervisorState,
          version: WRAPPER_VERSION,
          sessionId: '',
        });
      }

      if (method === 'POST' && path === '/job/init') {
        // Idempotent: return cached result if already initialized
        if (cachedInitResponse) {
          return jsonResponse(cachedInitResponse);
        }

        if (supervisorState === 'initializing') {
          return jsonResponse(
            { status: 'error', step: 'init', message: 'Initialization already in progress' },
            409
          );
        }

        supervisorState = 'initializing';
        logToFile('[supervisor] /job/init received, starting initialization');

        let body: SupervisorInitPayload;
        try {
          body = (await req.json()) as SupervisorInitPayload;
        } catch {
          supervisorState = 'waiting_for_init';
          return jsonResponse({ status: 'error', step: 'init', message: 'Invalid JSON body' }, 400);
        }

        if (
          !body.agentSessionId ||
          !body.userId ||
          !body.workspacePath ||
          !body.sessionHome ||
          !body.repo?.url ||
          !body.ingest?.url
        ) {
          supervisorState = 'waiting_for_init';
          return jsonResponse(
            {
              status: 'error',
              step: 'init',
              message:
                'Missing required fields: agentSessionId, userId, workspacePath, sessionHome, repo.url, ingest.url',
            },
            400
          );
        }

        const result = await Promise.race([
          handleInit(body),
          new Promise<InitFailure>(resolve =>
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  step: 'clone',
                  message: `Init timed out after ${INIT_TIMEOUT_MS / 1000}s`,
                }),
              INIT_TIMEOUT_MS
            )
          ),
        ]);

        if (!result.ok) {
          supervisorState = 'failed';
          cachedInitResponse = { status: 'error', step: result.step, message: result.message };
          return jsonResponse(cachedInitResponse);
        }

        cachedInitResponse = { status: 'ready', kiloSessionId: result.kiloSessionId };
        initContext = {
          body,
          kiloSessionId: result.kiloSessionId,
          kiloClient: result.kiloClient,
          kiloServer: result.kiloServer,
        };

        supervisorState = 'ready';
        logToFile(`[supervisor] init complete, kiloSessionId=${result.kiloSessionId}`);

        // Signal main() to proceed to phase 2
        resolveInitDone();

        return jsonResponse(cachedInitResponse);
      }

      return jsonResponse({ error: 'NOT_FOUND', message: `${method} ${path} not found` }, 404);
    },
  });

  logToFile(`[supervisor] bare server listening on port ${WRAPPER_PORT}`);

  // ------------------------------------------------------------------
  // Signal handling (registered early — before init may complete)
  // ------------------------------------------------------------------

  let isShuttingDown = false;

  async function handleShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logToFile(`[supervisor] shutdown signal: ${signal}`);
    console.error(`Received ${signal}, shutting down...`);

    if (runtime) {
      await shutdownRuntime(runtime, signal);
    }

    // Non-zero exit forces container death (per supervisor plan)
    process.exit(1);
  }

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  // ------------------------------------------------------------------
  // Crash handlers
  // ------------------------------------------------------------------

  installCrashHandlers(
    () => runtime?.state.logUploader ?? null,
    () => isShuttingDown,
    '[supervisor] '
  );

  // ------------------------------------------------------------------
  // Wait for /job/init to complete
  // ------------------------------------------------------------------

  await initDone;

  if (!initContext) {
    logToFile('[supervisor] initDone resolved but no context — should not happen');
    process.exit(1);
  }

  const { body, kiloSessionId, kiloClient, kiloServer } = initContext;

  // ------------------------------------------------------------------
  // Phase 2: Stop bare server, create full runtime
  // ------------------------------------------------------------------

  await bareServer.stop();
  logToFile('[supervisor] bare server stopped, creating full runtime');

  // Idempotent onInit for subsequent calls on the full runtime's server
  const onInit = async (_req: Request): Promise<Response> => {
    if (cachedInitResponse) {
      return jsonResponse(cachedInitResponse);
    }
    return jsonResponse(
      { status: 'error', step: 'init', message: 'Unexpected state: no cached init response' },
      500
    );
  };

  const getSupervisorState = (): string => supervisorState;

  // ------------------------------------------------------------------
  // Idle timeout — self-terminate after prolonged inactivity
  // ------------------------------------------------------------------

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function startIdleTimer(): void {
    clearIdleTimer();
    logToFile(`[supervisor] idle timer started (${SUPERVISOR_IDLE_TIMEOUT_MS / 1000}s)`);
    idleTimer = setTimeout(() => {
      logToFile('[supervisor] idle timeout reached, shutting down');
      if (runtime) {
        void shutdownRuntime(runtime, 'idle-timeout');
      } else {
        process.exit(0);
      }
    }, SUPERVISOR_IDLE_TIMEOUT_MS);
  }

  // ------------------------------------------------------------------
  // Execution watchdogs — detect hung or too-long turns
  // ------------------------------------------------------------------

  let activityCheckInterval: ReturnType<typeof setInterval> | null = null;
  let maxRuntimeTimer: ReturnType<typeof setTimeout> | null = null;

  function abortExecution(reason: string): void {
    if (!runtime?.state.isActive) return;
    logToFile(`[supervisor] aborting execution: ${reason}`);

    const { state, kiloClient: rtKiloClient, lifecycleManager } = runtime;

    state.sendToIngest({
      streamEventType: 'interrupted',
      data: { reason },
      timestamp: new Date().toISOString(),
    });

    const job = state.currentJob;
    if (job) {
      rtKiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
    }

    lifecycleManager.setAborted();
    state.setActive(false);
    lifecycleManager.triggerDrainAndClose();
  }

  function clearExecutionWatchdogs(): void {
    if (activityCheckInterval) {
      clearInterval(activityCheckInterval);
      activityCheckInterval = null;
    }
    if (maxRuntimeTimer) {
      clearTimeout(maxRuntimeTimer);
      maxRuntimeTimer = null;
    }
  }

  function startExecutionWatchdogs(): void {
    clearExecutionWatchdogs();

    // Activity timeout: abort if kilo goes silent
    activityCheckInterval = setInterval(() => {
      if (!runtime?.state.isActive) return;
      const silentMs = runtime.state.getIdleMs(Date.now());
      if (silentMs >= ACTIVITY_TIMEOUT_MS) {
        abortExecution(`No kilo events for ${Math.round(silentMs / 1000)}s`);
      }
    }, ACTIVITY_CHECK_INTERVAL_MS);

    // Max turn runtime: hard wall-clock limit
    maxRuntimeTimer = setTimeout(() => {
      if (!runtime?.state.isActive) return;
      abortExecution(`Turn exceeded max runtime (${MAX_TURN_RUNTIME_MS / 1000}s)`);
    }, MAX_TURN_RUNTIME_MS);
  }

  runtime = createRuntime({
    wrapperPort: WRAPPER_PORT,
    workspacePath: body.workspacePath,
    kiloSessionId,
    agentSessionId: body.agentSessionId,
    userId: body.userId,
    kiloClient,
    kiloServer,
    onInit,
    getSupervisorState,
    keepConnectionsAlive: true,
    onDrainComplete: () => {
      clearExecutionWatchdogs();
      startIdleTimer();
    },
    onBecameActive: () => {
      logToFile('[supervisor] activity detected, resetting timers');
      clearIdleTimer();
      startExecutionWatchdogs();
    },
  });

  // Pre-configure the supervisor job context with ingest details from init.
  // This opens the connection immediately and keeps it alive across turns.
  // Prompts arrive WITHOUT execution binding and reuse this context.
  {
    const { state } = runtime;
    const ingest = body.ingest;
    state.startJob({
      kiloSessionId,
      ingestUrl: ingest.url,
      ingestToken: ingest.token,
      workerAuthToken: ingest.workerAuthToken,
    });

    // Open the ingest connection now (before any prompt arrives)
    try {
      await runtime.connectionManager.open();
      logToFile('[supervisor] ingest connection opened at init');
    } catch (err) {
      logToFile(
        `[supervisor] failed to open ingest connection: ${err instanceof Error ? err.message : String(err)}`
      );
      // Non-fatal: connection will be opened on first prompt
    }

    // Create log uploader (session-keyed, no executionId)
    const workerBaseUrl = new URL(ingest.url);
    workerBaseUrl.protocol =
      workerBaseUrl.protocol === 'wss:' || workerBaseUrl.protocol === 'https:' ? 'https:' : 'http:';
    const logUploader = createLogUploader({
      workerBaseUrl: workerBaseUrl.origin,
      sessionId: body.agentSessionId,
      userId: body.userId,
      workerAuthToken: ingest.workerAuthToken,
      cliLogDir: `/home/${body.agentSessionId}/.local/share/kilo/log`,
      wrapperLogPath: process.env.WRAPPER_LOG_PATH ?? '/tmp/kilocode-wrapper.log',
    });
    state.setLogUploader(logUploader);
    logUploader.start();
    logToFile('[supervisor] log uploader started');
  }

  // Start initial idle timer — if the DO never sends a prompt, we'll self-terminate.
  // Resets when the first prompt arrives via onBecameActive.
  startIdleTimer();

  logToFile(
    `[supervisor] full runtime ready on port ${WRAPPER_PORT} (kilo server at ${kiloServer.url})`
  );
  console.log(`Supervisor ready on port ${WRAPPER_PORT}`);
}

main().catch(err => {
  logToFile(`[supervisor] fatal error: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Supervisor fatal error:', err);
  process.exit(1);
});
