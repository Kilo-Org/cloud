// Dependency-free HTTP server that runs one decider-benchmark case through the
// stable `kilo` CLI per request. Intentionally dumb: it spawns the CLI, caps
// output, and returns raw stdout lines. All event parsing happens in the
// worker (src/kilo-events.ts), not here.
//
// The Kilo user token is passed in the request body and injected only as a
// child-process env var (KILO_AUTH_CONTENT). It is never written to disk and
// never logged.

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

class NotStartedError extends Error {}

// A case accepted before SIGTERM but not yet spawned never reaches a provider.
function runCaseSerialized(params) {
  return serializeCli(() => {
    if (stopRequested) throw new NotStartedError('container is stopping');
    return runCase(params);
  });
}

const RESULT_DELIVERY_ATTEMPTS = 3;

// A rollout tears down the caller's connection while this process drains, so the
// outcome is also posted to the worker, which persists it as recoverable output.
async function deliverResult(callback, outcome) {
  for (let attempt = 1; attempt <= RESULT_DELIVERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(callback.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ execution: callback.execution, outcome }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || response.status === 404) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
  }
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

let warmup = null;
function warmUpOnce() {
  if (!warmup) {
    const env = { ...process.env, KILO_DISABLE_SESSION_INGEST: '1', NO_COLOR: '1' };
    delete env.KILO_AUTH_CONTENT;
    delete env.KILO_API_URL;
    delete env.KILO_ORG_ID;
    warmup = serializeCli(() =>
      runCli({ args: ['db', 'path'], env, timeoutMs: DEFAULT_TIMEOUT_MS })
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

function runCase({ model, prompt, kiloToken, kiloApiUrl, orgId, timeoutMs, variant }) {
  const resolvedOrgId = typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
  const args = ['run', '--format', 'json', '--auto', '-m', `kilo/${model}`];
  if (typeof variant === 'string' && variant.length > 0) args.push('--variant', variant);
  args.push(prompt);
  return runCli({
    args,
    env: {
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
    },
    timeoutMs,
    kiloToken,
  });
}

async function runCli({ args, env, timeoutMs, kiloToken }) {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-bench-'));
  const startedAt = Date.now();
  let result;
  try {
    result = await new Promise(resolve => {
      let timedOut = false;
      let stdout = '';
      let stdoutTruncated = false;
      let stderrTail = '';
      // The kilo wrapper spawns a grandchild; timeout must kill its whole group.
      const child = spawn('kilo', args, {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let finished = false;
      let finishTimer;
      const finish = exitCode => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        clearTimeout(finishTimer);
        resolve({
          exitCode,
          stdoutLines: stdout.split('\n').filter(line => line.length > 0),
          stderrTail:
            typeof kiloToken === 'string' && kiloToken.length > 0
              ? stderrTail.split(kiloToken).join('[redacted]')
              : stderrTail,
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
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

const server = createServer(
  { requestTimeout: 30_000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 },
  (req, res) => {
    activeHttpRequests += 1;
    let responseFinished = false;
    const finishRequest = () => {
      if (responseFinished) return;
      responseFinished = true;
      activeHttpRequests -= 1;
      exitWhenIdle();
    };
    res.once('finish', finishRequest);
    res.once('close', finishRequest);
    void (async () => {
      if (stopRequested) {
        sendJson(res, 503, { error: 'container is stopping' });
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/warmup') {
        req.resume();
        const result = await warmUpOnce();
        sendJson(res, 200, { exitCode: result.exitCode, durationMs: result.durationMs });
        return;
      }

      if (req.method === 'POST' && req.url === '/run') {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }

        if (stopRequested) {
          sendJson(res, 503, { error: 'container is stopping' });
          return;
        }
        const { model, prompt, kiloToken, kiloApiUrl, orgId, variant, resultCallback } =
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
          sendJson(res, 400, {
            error: 'model, prompt, kiloToken and kiloApiUrl are required strings',
          });
          return;
        }
        if (orgId !== undefined && orgId !== null && typeof orgId !== 'string') {
          sendJson(res, 400, { error: 'orgId must be a string when provided' });
          return;
        }

        if (variant !== undefined && variant !== null && typeof variant !== 'string') {
          sendJson(res, 400, { error: 'variant must be a string when provided' });
          return;
        }
        const callback = isResultCallback(resultCallback) ? resultCallback : null;
        if (callback) pendingDeliveries += 1;
        let outcome;
        let failure = null;
        try {
          outcome = {
            kind: 'completed',
            response: await runCaseSerialized({
              model,
              prompt,
              kiloToken,
              kiloApiUrl,
              orgId,
              timeoutMs,
              variant,
            }),
          };
        } catch (err) {
          outcome = { kind: 'not_started' };
          if (!(err instanceof NotStartedError)) {
            failure = err instanceof Error ? err.message : 'run failed';
          }
        }
        const responseDelivered = !res.destroyed && !responseFinished;
        if (outcome.kind === 'completed') sendJson(res, 200, outcome.response);
        else if (failure) sendJson(res, 500, { error: failure });
        else sendJson(res, 503, { error: 'container is stopping' });
        if (!callback) return;
        if (outcome.kind === 'not_started' || stopRequested || !responseDelivered) {
          await deliverResult(callback, outcome);
        }
        pendingDeliveries -= 1;
        exitWhenIdle();
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    })().catch(error => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'run failed' });
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
