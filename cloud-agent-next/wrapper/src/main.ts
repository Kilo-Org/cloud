/**
 * Long-running wrapper entry point.
 *
 * The wrapper runs as a single control plane inside the sandbox container.
 * It starts the kilo server in-process via `@kilocode/sdk`'s `createKilo()`,
 * then exposes an HTTP API for the Worker to send commands.
 *
 * Configuration:
 * - Session-level: WRAPPER_PORT, WORKSPACE_PATH (env vars at process start)
 * - Session identity: --agent-session, --user-id, --session-id (CLI args at process start)
 * - Execution-level: passed via POST /job/prompt body (per-turn)
 */

import { SESSION_ID_RE } from '../../src/shared/protocol.js';
import { logToFile, installCrashHandlers } from './utils.js';
import {
  initKilo,
  createOrVerifySession,
  createRuntime,
  shutdownRuntime,
} from './lib/kilo-runtime.js';

// ---------------------------------------------------------------------------
// Environment Variable Parsing
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logToFile(`ERROR: Missing required environment variable: ${name}`);
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function getOptionalEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logToFile(`WARNING: Invalid integer for ${name}: ${value}, using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function failStartup(message: string): never {
  logToFile(`ERROR: ${message}`);
  console.error(message);
  process.exit(1);
}

type StartupArgs = {
  agentSessionId: string;
  userId: string;
  sessionId?: string;
};

function parseStartupArgs(argv: string[]): StartupArgs {
  let agentSessionId: string | undefined;
  let userId: string | undefined;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--agent-session') {
      if (!value) {
        failStartup('Missing value for --agent-session');
      }
      agentSessionId = value;
      index++;
      continue;
    }

    if (arg === '--user-id') {
      if (!value) {
        failStartup('Missing value for --user-id');
      }
      userId = value;
      index++;
      continue;
    }

    if (arg === '--session-id') {
      if (!value) {
        failStartup('Missing value for --session-id');
      }
      sessionId = value;
      index++;
      continue;
    }

    failStartup(`Unknown argument: ${arg}`);
  }

  if (!agentSessionId) {
    failStartup('Missing required --agent-session argument');
  }

  if (!userId) {
    failStartup('Missing required --user-id argument');
  }

  return { agentSessionId, userId, sessionId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logToFile(`wrapper starting (long-running mode) bun=${Bun.version}`);

  // Parse environment variables and startup args — only session-stable config remains here.
  // Per-execution config (autoCommit, condenseOnComplete, model, upstreamBranch)
  // is now passed in the POST /job/prompt body.
  const wrapperPort = getOptionalEnvInt('WRAPPER_PORT', 5000);
  const workspacePath = getRequiredEnv('WORKSPACE_PATH');
  const {
    agentSessionId,
    userId,
    sessionId: configuredSessionId,
  } = parseStartupArgs(process.argv.slice(2));

  if (!SESSION_ID_RE.test(agentSessionId)) {
    failStartup(`Invalid agent session ID: ${agentSessionId}`);
  }

  // The wrapper process is started with cwd outside the workspace.
  // Switch into the workspace now so the kilo server (started in-process)
  // sees the correct project root. This is an attempt to fix an issue where
  // the bun process crashes in some repos but not others.
  process.chdir(workspacePath);

  // Set log path if not already set
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${Date.now()}.log`;
  }

  logToFile(
    `config: wrapperPort=${wrapperPort} workspacePath=${workspacePath} agentSessionId=${agentSessionId}`
  );
  if (configuredSessionId) {
    logToFile(`config: sessionId=${configuredSessionId}`);
  }

  // ---------------------------------------------------------------------------
  // Start kilo server and create/verify session
  // ---------------------------------------------------------------------------
  let kiloInit;
  try {
    kiloInit = await initKilo();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile(`failed to start kilo server: ${msg}`);
    console.error('Failed to start kilo server:', msg);
    process.exit(1);
  }

  const { kiloClient, kiloServer } = kiloInit;

  let kiloSessionId: string;
  if (configuredSessionId) {
    try {
      kiloSessionId = await createOrVerifySession(kiloClient, configuredSessionId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failStartup(`configured session ${configuredSessionId} not found: ${msg}`);
    }
  } else {
    kiloSessionId = await createOrVerifySession(kiloClient);
  }

  // ---------------------------------------------------------------------------
  // Wire up components
  // ---------------------------------------------------------------------------
  const runtime = createRuntime({
    wrapperPort,
    workspacePath,
    kiloSessionId,
    agentSessionId,
    userId,
    kiloClient,
    kiloServer,
  });

  logToFile(`wrapper ready on port ${wrapperPort} (kilo server at ${kiloServer.url})`);
  console.log(`Wrapper listening on port ${wrapperPort}`);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  let isShuttingDown = false;

  async function handleShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await shutdownRuntime(runtime, signal);
  }

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  // ---------------------------------------------------------------------------
  // Crash handlers — best-effort log upload on unexpected crashes
  // ---------------------------------------------------------------------------
  installCrashHandlers(
    () => runtime.state.logUploader,
    () => isShuttingDown
  );
}

main().catch(err => {
  logToFile(`fatal error: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Wrapper fatal error:', err);
  process.exit(1);
});
