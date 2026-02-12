import { parseArgs } from 'util';
import { createConnection, type Connection } from './connection.js';
import { createKilocodeRunner, type KilocodeRunner } from './kilocode-runner.js';
import { runAutoCommit } from './auto-commit.js';
import { runCondenseOnComplete } from './condense-on-complete.js';
import { getCurrentBranch, logToFile } from './utils.js';

// Parse CLI args (execution-specific)
const { values: args } = parseArgs({
  options: {
    'execution-id': { type: 'string' },
    'ingest-token': { type: 'string' },
    mode: { type: 'string' },
    prompt: { type: 'string' },
    'auto-commit': { type: 'boolean', default: false },
    'condense-on-complete': { type: 'boolean', default: false },
    'idle-timeout': { type: 'string', default: '240000' },
    'append-system-prompt-file': { type: 'string' },
  },
  strict: true,
});

let isShuttingDown = false;
let runner: KilocodeRunner | null = null;
let conn: Connection | null = null;
let sentFatalError = false;

/** Grace period before force exit (20 seconds) */
const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main() {
  logToFile('wrapper start');
  // Pull out args values with explicit checking
  const executionId = args['execution-id'];
  const ingestToken = args['ingest-token'];
  const mode = args['mode'];
  const promptFile = args['prompt'];
  const autoCommit = args['auto-commit'] ?? false;
  const condenseOnComplete = args['condense-on-complete'] ?? false;
  const idleTimeoutMs = parseInt(args['idle-timeout'] ?? '240000', 10);
  const appendSystemPromptFile = args['append-system-prompt-file'];

  // Validate required args
  if (!executionId || !ingestToken || !mode || !promptFile) {
    logToFile('missing required arguments');
    console.error('Missing required arguments: --execution-id, --ingest-token, --mode, --prompt');
    process.exit(1);
  }
  if (!process.env.WRAPPER_LOG_PATH) {
    process.env.WRAPPER_LOG_PATH = `/tmp/kilocode-wrapper-${executionId}.log`;
  }

  // Validate required env vars
  const ingestUrl = process.env.INGEST_URL;
  const sessionId = process.env.SESSION_ID;
  const userId = process.env.USER_ID;
  const workspacePath = process.env.WORKSPACE_PATH;
  const kilocodeToken = process.env.KILOCODE_TOKEN;
  const kiloSessionId = process.env.KILO_SESSION_ID || undefined;
  const upstreamBranch = process.env.UPSTREAM_BRANCH || undefined;

  if (!ingestUrl || !sessionId || !userId || !workspacePath || !kilocodeToken) {
    logToFile('missing required environment variables');
    console.error('Missing required environment variables');
    process.exit(1);
  }
  logToFile(`wrapper args executionId=${executionId} mode=${mode} promptFile=${promptFile}`);
  logToFile(`wrapper env sessionId=${sessionId} userId=${userId} workspacePath=${workspacePath}`);

  // 1. Connect to /ingest WebSocket
  const connection = await createConnection({
    ingestUrl,
    executionId,
    sessionId,
    userId,
    token: ingestToken,
    kilocodeToken,
  });
  conn = connection;
  logToFile('ingest connection established');

  // 2. Read prompt from file
  const prompt = await Bun.file(promptFile).text();
  logToFile(`prompt loaded chars=${prompt.length}`);

  // 2b. Log appendSystemPromptFile if provided
  if (appendSystemPromptFile) {
    logToFile(`appendSystemPromptFile=${appendSystemPromptFile}`);
  }

  // 3. Start kilocode
  runner = createKilocodeRunner({
    mode,
    prompt,
    workspacePath,
    kiloSessionId,
    idleTimeoutMs,
    appendSystemPromptFile,
    onEvent: event => connection.send(event),
    onTerminalEvent: reason => {
      sentFatalError = true;
      logToFile(`terminal event reason=${reason}`);
      connection.send({
        streamEventType: 'error',
        data: { error: reason, fatal: true },
        timestamp: new Date().toISOString(),
      });
    },
  });
  logToFile('kilocode runner started');

  // Handle commands from DO
  connection.onCommand(cmd => {
    logToFile(`command received type=${cmd.type}`);
    if (cmd.type === 'kill') {
      runner?.kill(cmd.signal || 'SIGTERM');
    }
    if (cmd.type === 'ping') {
      connection.send({
        streamEventType: 'pong',
        data: { executionId },
        timestamp: new Date().toISOString(),
      });
    }
  });

  connection.send({
    streamEventType: 'started',
    data: { executionId, mode },
    timestamp: new Date().toISOString(),
  });

  // 4. Wait for kilocode to finish
  const result = await runner.wait();
  logToFile(
    `kilocode runner exit code=${result.exitCode} signal=${result.signal ?? 'none'} wasKilled=${result.wasKilled}`
  );

  // 5. Check if the process was killed/interrupted
  const wasInterrupted = result.wasKilled || result.signal !== null;

  if (wasInterrupted && !isShuttingDown && !sentFatalError) {
    // Process was interrupted but NOT by signal handler (which already sent interrupted event)
    connection.send({
      streamEventType: 'interrupted',
      data: {
        reason: result.signal || 'killed',
        exitCode: result.exitCode,
      },
      timestamp: new Date().toISOString(),
    });
  } else if (isShuttingDown) {
    // Signal handler already sent interrupted event, skip auto-commit but don't send duplicate
  } else {
    // Normal completion - run auto-commit if enabled and successful
    if (autoCommit && result.exitCode === 0) {
      logToFile('auto-commit start');
      await runAutoCommit({
        workspacePath,
        upstreamBranch,
        onEvent: event => connection.send(event),
      });
      logToFile('auto-commit complete');
    }

    // Run condense-on-complete if enabled and successful (requires kiloSessionId)
    if (condenseOnComplete && result.exitCode === 0 && kiloSessionId) {
      logToFile('condense-on-complete start');
      await runCondenseOnComplete({
        workspacePath,
        kiloSessionId,
        onEvent: event => connection.send(event),
      });
      logToFile('condense-on-complete complete');
    }

    // Capture branch and send complete
    const currentBranch = await getCurrentBranch(workspacePath);
    connection.send({
      streamEventType: 'complete',
      data: { exitCode: result.exitCode, currentBranch: currentBranch || undefined },
      timestamp: new Date().toISOString(),
    });
  }

  // 6. Give buffer a moment to flush, then cleanup
  await new Promise(resolve => setTimeout(resolve, 500));
  await connection.close();
  logToFile('wrapper exiting');
  process.exit(result.exitCode);
}

// Signal handling for graceful shutdown
function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.error(`Received ${signal}, shutting down...`);
  logToFile(`signal received ${signal}`);

  // Send interrupted event immediately if connection is available
  if (conn) {
    try {
      conn.send({
        streamEventType: 'interrupted',
        data: { reason: `Container shutdown: ${signal}` },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Ignore send errors during shutdown
    }
  }

  // Kill the child process
  if (runner) {
    runner.kill('SIGTERM');
  }

  // Force exit after timeout if child doesn't exit
  setTimeout(() => {
    console.error('Force exiting after timeout');
    logToFile('force exiting after timeout');
    try {
      void conn?.close();
    } catch {
      // Ignore close errors
    }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main().catch(err => {
  logToFile(`wrapper fatal error ${err instanceof Error ? err.message : String(err)}`);
  console.error('Wrapper fatal error:', err);
  process.exit(1);
});
