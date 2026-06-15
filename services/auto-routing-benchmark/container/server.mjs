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

// The CLI's one-time sqlite migration (and its state dir generally) is not
// safe under concurrent first runs; serialize every CLI execution in this
// instance. Callers see requests queue, which is fine for benchmark traffic.
let runChain = Promise.resolve();
function runCaseSerialized(params) {
  const next = runChain.then(() => runCase(params));
  runChain = next.catch(() => {});
  return next;
}

function runCase({ model, prompt, kiloToken, timeoutMs, variant }) {
  return new Promise(resolve => {
    void (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kilo-bench-'));
      const startedAt = Date.now();
      let timedOut = false;

      let stdout = '';
      let stdoutTruncated = false;
      let stderrTail = '';

      const args = ['run', '--format', 'json', '--auto', '-m', `kilo/${model}`];
      // Reasoning effort: forwarded as the CLI's provider-specific variant.
      if (typeof variant === 'string' && variant.length > 0) args.push('--variant', variant);
      args.push(prompt);
      // detached: the `kilo` bin is a wrapper that spawns the real CLI binary
      // as a grandchild. Killing only the wrapper orphans the grandchild: it
      // keeps running (and spending) and holds the stdout/stderr pipes open,
      // so 'close' never fires and the case hangs forever. A detached child
      // leads its own process group, letting the timeout kill the whole tree.
      const child = spawn('kilo', args, {
        cwd: dir,
        env: {
          ...process.env,
          KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kiloToken } }),
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      const killProcessTree = () => {
        // Negative pid = the child's whole process group (wrapper + real CLI).
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const killTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree();
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

      // 'error' and 'close' can both fire for the same child (Node emits
      // 'close' after 'error' on spawn failure); only the first wins.
      let finished = false;
      const finish = async exitCode => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        const stdoutLines = stdout.split('\n').filter(line => line.length > 0);
        // Defense in case a future CLI version echoes auth material to stderr.
        const redactedStderrTail = stderrTail.split(kiloToken).join('[redacted]');
        resolve({
          exitCode,
          durationMs: Date.now() - startedAt,
          stdoutLines,
          stderrTail: redactedStderrTail,
          timedOut,
        });
      };

      child.on('error', err => {
        stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-STDERR_CAP_BYTES);
        void finish(-1);
      });
      child.on('close', code => {
        void finish(code ?? -1);
      });
      // Backstop for 'close' never firing: a stray process that survives the
      // group kill (e.g. a tool process that moved to its own group) can hold
      // the stdio pipes open indefinitely. After the child itself has exited,
      // give the streams a short grace to flush, then finish regardless.
      child.on('exit', code => {
        setTimeout(() => void finish(code ?? -1), 5_000).unref();
      });
    })();
  });
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // One-time CLI warmup (sqlite migration on a fresh instance): a trivial
    // serialized run so real cases never burn their timeout on it.
    if (req.method === 'POST' && req.url === '/warmup') {
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const { model, kiloToken } = parsed ?? {};
      if (typeof model !== 'string' || typeof kiloToken !== 'string') {
        sendJson(res, 400, { error: 'model and kiloToken are required strings' });
        return;
      }
      const result = await runCaseSerialized({
        model,
        prompt: 'Reply with exactly: ok',
        kiloToken,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
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

      const { model, prompt, kiloToken, variant } = parsed ?? {};
      const timeoutMs =
        typeof parsed?.timeoutMs === 'number' && parsed.timeoutMs > 0
          ? parsed.timeoutMs
          : DEFAULT_TIMEOUT_MS;

      if (
        typeof model !== 'string' ||
        typeof prompt !== 'string' ||
        typeof kiloToken !== 'string'
      ) {
        sendJson(res, 400, { error: 'model, prompt and kiloToken are required strings' });
        return;
      }

      try {
        if (variant !== undefined && variant !== null && typeof variant !== 'string') {
          sendJson(res, 400, { error: 'variant must be a string when provided' });
          return;
        }
        const result = await runCaseSerialized({ model, prompt, kiloToken, timeoutMs, variant });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'run failed' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  })();
});

server.listen(PORT, () => {
  console.log(`decider-benchmark runner listening on :${PORT}`);
});
