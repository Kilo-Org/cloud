// Dependency-free HTTP server that runs one decider-benchmark case through the
// stable `kilo` CLI per request. Intentionally dumb: it spawns the CLI, caps
// output, and returns raw stdout lines. All event parsing happens in the
// worker (src/kilo-events.ts), not here.
//
// The Kilo user token is passed in the request body and injected only as a
// child-process env var (KILO_AUTH_CONTENT). It is never written to disk and
// never logged. Every captured child stream this server returns or delivers has
// each occurrence of the token replaced with '[redacted]'.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3000;
const DEFAULT_TIMEOUT_MS = 180_000;
const STDOUT_CAP_BYTES = 2 * 1024 * 1024; // 2MB
const STDERR_CAP_BYTES = 4 * 1024; // 4KB tail

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The CLI's sqlite state is shared by every invocation in this instance.
let runChain = Promise.resolve();
let activeCliJobs = 0;
let activeHttpRequests = 0;
let stopRequested = false;
let pendingDeliveries = 0;

function exitWhenIdle() {
  if (stopRequested && activeCliJobs === 0 && activeHttpRequests === 0 && pendingDeliveries === 0) {
    process.exit(0);
  }
}

function serializeCli(run) {
  activeCliJobs += 1;
  const next = runChain.then(run).finally(() => {
    activeCliJobs -= 1;
    exitWhenIdle();
  });
  runChain = next.catch(() => {});
  return next;
}

class NotStartedError extends Error {
  constructor(message, category) {
    super(message);
    this.category = category;
  }
}

// A case accepted before SIGTERM but not yet spawned never reaches a provider.
function runCaseSerialized(params) {
  return serializeCli(() => {
    if (stopRequested) throw new NotStartedError('container is stopping', 'shutdown');
    return runCase(params);
  });
}

// Waits between delivery attempts: with a 10-second timeout per attempt, the ten
// attempts span at most ~5.5 minutes, enough to outlast a few minutes of D1 overload.
// The worker's CONTAINER_DELIVERY_WINDOW_MS (src/run.ts) waits for the whole schedule.
const RESULT_DELIVERY_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 45_000, 60_000, 60_000,
];
const RESULT_DELIVERY_ATTEMPTS = RESULT_DELIVERY_RETRY_DELAYS_MS.length + 1;
const RESPONSE_COMPLETION_TIMEOUT_MS = 10_000;

function logCaseEvent(event, context, details, level = 'log') {
  console[level](JSON.stringify({ event, ...context, ...details }));
}

// A successful HTTP write does not prove the worker persisted the result. Once the first
// attempt fails, `onRetrying` lets the caller answer while later attempts continue.
async function deliverResult(callback, outcome, context, onRetrying) {
  const body = JSON.stringify({ execution: callback.execution, outcome });
  let category = 'http_error';
  for (let attempt = 1; attempt <= RESULT_DELIVERY_ATTEMPTS; attempt++) {
    const details = { attempt, outcome: outcome.kind };
    logCaseEvent('benchmark_container_result_delivery_attempt', context, {
      ...details,
      category: 'pending',
    });
    try {
      const response = await fetch(callback.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        logCaseEvent('benchmark_container_result_delivered', context, {
          ...details,
          category: 'accepted',
        });
        return;
      }
      if (response.status === 404) {
        logCaseEvent(
          'benchmark_container_result_rejected',
          context,
          { ...details, category: 'not_found' },
          'warn'
        );
        return;
      }
      category = 'http_error';
    } catch (error) {
      category =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timeout'
          : 'network_error';
    }
    logCaseEvent('benchmark_container_result_delivery_failed', context, {
      ...details,
      category,
    });
    if (attempt < RESULT_DELIVERY_ATTEMPTS) {
      if (attempt === 1) onRetrying();
      await new Promise(resolve =>
        setTimeout(resolve, RESULT_DELIVERY_RETRY_DELAYS_MS[attempt - 1])
      );
    }
  }
  logCaseEvent(
    'benchmark_container_result_delivery_exhausted',
    context,
    {
      category,
      outcome: outcome.kind,
      attempt: RESULT_DELIVERY_ATTEMPTS,
      attempts: RESULT_DELIVERY_ATTEMPTS,
    },
    'error'
  );
}

function isResultCallback(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.url === 'string' &&
    typeof value.execution === 'object' &&
    value.execution !== null
  );
}

function executionContext(callback, model, variant) {
  const execution = callback?.execution;
  return {
    runId: typeof execution?.runId === 'string' ? execution.runId : null,
    model: typeof execution?.model === 'string' ? execution.model : model,
    variant: typeof execution?.variant === 'string' ? execution.variant : (variant ?? ''),
    rep: Number.isInteger(execution?.rep) ? execution.rep : null,
    caseId: typeof execution?.caseId === 'string' ? execution.caseId : null,
    attemptStartedAt: Number.isInteger(execution?.attemptStartedAt)
      ? execution.attemptStartedAt
      : null,
    retried: execution?.retried === true,
  };
}

let warmup = null;
function warmUpOnce() {
  if (!warmup) {
    const env = { ...process.env, KILO_DISABLE_SESSION_INGEST: '1', NO_COLOR: '1' };
    delete env.KILO_AUTH_CONTENT;
    delete env.KILO_API_URL;
    delete env.KILO_ORG_ID;
    warmup = serializeCli(() =>
      withWorkspace(cwd =>
        runCli({ args: ['db', 'path'], cwd, env, timeoutMs: DEFAULT_TIMEOUT_MS })
      )
    ).then(
      result => {
        if (result.exitCode !== 0) warmup = null;
        return result;
      },
      error => {
        warmup = null;
        throw error;
      }
    );
  }
  return warmup;
}

async function withWorkspace(run) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'kilo-bench-'));
  } catch (error) {
    throw new NotStartedError(
      error instanceof Error ? error.message : 'case workspace failed',
      'workspace_error'
    );
  }
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The prompt goes to the CLI on stdin, never argv: Linux caps one argv string at
// 128 KiB (MAX_ARG_STRLEN), which a long-context case exceeds, and `kilo run` re-quotes
// argv messages that contain spaces. With no positional message it reads stdin to EOF
// and sends that text verbatim as the user message.
//
// The CLI takes its working directory from PWD before the process cwd, and the inherited
// PWD is the image's WORKDIR (/app), which every case of the instance shares. An isolated
// case runs in its own workspace instead; ordinary cases keep /app so their prompts and
// tool results stay identical to the results already measured.
//
function runCase({
  model,
  prompt,
  isolated,
  kiloToken,
  kiloApiUrl,
  orgId,
  timeoutMs,
  variant,
  context,
}) {
  const resolvedOrgId = typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
  const args = ['run', '--format', 'json', '--auto', '-m', `kilo/${model}`];
  if (typeof variant === 'string' && variant.length > 0) args.push('--variant', variant);
  const runEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: JSON.stringify({
      kilo: {
        type: 'api',
        key: kiloToken,
        ...(resolvedOrgId ? { organizationId: resolvedOrgId } : {}),
      },
    }),
    KILO_API_URL: kiloApiUrl,
    KILO_DISABLE_SESSION_INGEST: '1',
    ...(resolvedOrgId ? { KILO_ORG_ID: resolvedOrgId } : {}),
    NO_COLOR: '1',
  };
  return withWorkspace(async cwd => {
    const env = isolated ? { ...runEnv, PWD: cwd } : runEnv;
    return runCli({ args, cwd, stdin: prompt, env, timeoutMs, kiloToken, context });
  });
}

// Nothing the child writes reaches a caller unread: each captured stream is scrubbed
// with the one credential this server injects before it is returned or delivered.
function redactToken(text, kiloToken) {
  return typeof kiloToken === 'string' && kiloToken.length > 0
    ? text.split(kiloToken).join('[redacted]')
    : text;
}

async function runCli({ args, cwd, stdin, env, timeoutMs, kiloToken, context }) {
  const startedAt = Date.now();
  const result = await new Promise(resolve => {
    let timedOut = false;
    let stdout = '';
    let stdoutTruncated = false;
    let stderrTail = '';
    // The kilo wrapper spawns a grandchild; timeout must kill its whole group.
    let child;
    try {
      child = spawn('kilo', args, {
        cwd,
        env,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      throw new NotStartedError(
        error instanceof Error ? error.message : 'case process failed',
        'spawn_error'
      );
    }
    if (context && typeof child.pid === 'number') {
      logCaseEvent('benchmark_container_case_started', context, {
        outcome: 'running',
        category: 'spawned',
      });
    }
    if (stdin !== undefined) {
      // A CLI that exits before reading everything closes the pipe; its exit code reports it.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    let finished = false;
    let finishTimer;
    const finish = exitCode => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      resolve({
        exitCode,
        stdoutLines: stdout
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => redactToken(line, kiloToken)),
        stderrTail: redactToken(stderrTail, kiloToken),
        timedOut,
      });
    };
    // A surviving grandchild can keep the pipes open after the CLI exits.
    const finishAfterExit = exitCode => {
      if (finished || finishTimer) return;
      finishTimer = setTimeout(() => finish(exitCode), 5_000);
      finishTimer.unref();
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      finishAfterExit(-1);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          return;
        }
      }
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (stdoutTruncated) return;
      const text = chunk.toString('utf8');
      if (stdout.length + text.length > STDOUT_CAP_BYTES) {
        stdout += text.slice(0, STDOUT_CAP_BYTES - stdout.length);
        stdoutTruncated = true;
      } else {
        stdout += text;
      }
    });
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_CAP_BYTES);
    });
    child.on('error', error => {
      stderrTail = (stderrTail + `\nspawn error: ${error.message}`).slice(-STDERR_CAP_BYTES);
      finish(-1);
    });
    child.on('close', code => finish(code ?? -1));
    child.on('exit', code => finishAfterExit(code ?? -1));
  });
  result.durationMs = Date.now() - startedAt;
  return result;
}

const server = createServer(
  { requestTimeout: 30_000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 },
  (req, res) => {
    activeHttpRequests += 1;
    let responseSettled = false;
    let responseDeadline;
    const finishRequest = () => {
      if (responseSettled) return;
      responseSettled = true;
      clearTimeout(responseDeadline);
      activeHttpRequests -= 1;
      exitWhenIdle();
    };
    res.once('finish', finishRequest);
    res.once('close', finishRequest);
    res.once('error', finishRequest);
    const sendResponse = (status, body) => {
      try {
        sendJson(res, status, body);
      } catch {
        finishRequest();
      }
    };
    void (async () => {
      if (stopRequested) {
        sendResponse(503, { error: 'container is stopping' });
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        sendResponse(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/warmup') {
        req.resume();
        const result = await warmUpOnce();
        sendResponse(200, { exitCode: result.exitCode, durationMs: result.durationMs });
        return;
      }

      if (req.method === 'POST' && req.url === '/run') {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendResponse(400, { error: 'invalid JSON body' });
          return;
        }

        const { model, prompt, kiloToken, kiloApiUrl, orgId, variant, resultCallback, isolated } =
          parsed ?? {};
        const timeoutMs =
          typeof parsed?.timeoutMs === 'number' && parsed.timeoutMs > 0
            ? parsed.timeoutMs
            : DEFAULT_TIMEOUT_MS;

        if (
          typeof model !== 'string' ||
          typeof prompt !== 'string' ||
          typeof kiloToken !== 'string' ||
          typeof kiloApiUrl !== 'string'
        ) {
          sendResponse(400, {
            error: 'model, prompt, kiloToken and kiloApiUrl are required strings',
          });
          return;
        }
        if (orgId !== undefined && orgId !== null && typeof orgId !== 'string') {
          sendResponse(400, { error: 'orgId must be a string when provided' });
          return;
        }

        if (variant !== undefined && variant !== null && typeof variant !== 'string') {
          sendResponse(400, { error: 'variant must be a string when provided' });
          return;
        }
        if (isolated !== undefined && isolated !== null && typeof isolated !== 'boolean') {
          sendResponse(400, { error: 'isolated must be a boolean when provided' });
          return;
        }
        const callback = isResultCallback(resultCallback) ? resultCallback : null;
        const context = executionContext(callback, model, variant);
        logCaseEvent('benchmark_container_case_accepted', context, {
          outcome: 'pending',
          category: 'queued',
        });
        if (callback) pendingDeliveries += 1;
        try {
          let outcome;
          let failure = null;
          let category;
          try {
            if (stopRequested) throw new NotStartedError('container is stopping', 'shutdown');
            outcome = {
              kind: 'completed',
              response: await runCaseSerialized({
                model,
                prompt,
                isolated: isolated === true,
                kiloToken,
                kiloApiUrl,
                orgId,
                timeoutMs,
                variant,
                context,
              }),
            };
            category = outcome.response.timedOut
              ? 'timeout'
              : outcome.response.exitCode === 0
                ? 'success'
                : 'cli_error';
          } catch (err) {
            // A case may only be reported as never started when no child was spawned.
            if (err instanceof NotStartedError) {
              outcome = { kind: 'not_started' };
              category = err.category;
              if (!stopRequested) failure = err.message;
            } else {
              outcome = { kind: 'failed' };
              category = 'execution_error';
              failure = err instanceof Error ? err.message : 'run failed';
            }
          }
          logCaseEvent('benchmark_container_case_settled', context, {
            outcome: outcome.kind,
            category,
          });
          let responded = false;
          const respond = () => {
            if (responded) return;
            responded = true;
            if (outcome.kind === 'completed') sendResponse(200, outcome.response);
            else if (failure) sendResponse(500, { error: failure });
            else sendResponse(503, { error: 'container is stopping' });
            if (callback && !responseSettled) {
              responseDeadline = setTimeout(() => {
                finishRequest();
                res.destroy();
              }, RESPONSE_COMPLETION_TIMEOUT_MS);
              responseDeadline.unref();
            }
          };
          if (callback && (outcome.kind === 'completed' || outcome.kind === 'not_started')) {
            await deliverResult(callback, outcome, context, respond);
          }
          respond();
        } finally {
          if (callback) {
            pendingDeliveries -= 1;
            exitWhenIdle();
          }
        }
        return;
      }

      sendResponse(404, { error: 'not found' });
    })().catch(error => {
      sendResponse(500, { error: error instanceof Error ? error.message : 'run failed' });
    });
  }
);

server.listen(PORT, () => {
  console.log(`decider-benchmark runner listening on :${PORT}`);
});

// Node is PID 1, so SIGTERM needs an explicit handler.
process.on('SIGTERM', () => {
  if (stopRequested) return;
  stopRequested = true;
  server.close();
  exitWhenIdle();
});
