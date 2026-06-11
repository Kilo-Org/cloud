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

function runCase({ model, prompt, kiloToken, timeoutMs }) {
  return new Promise(resolve => {
    void (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kilo-bench-'));
      const startedAt = Date.now();

      let stdout = '';
      let stdoutTruncated = false;
      let stderrTail = '';

      const child = spawn(
        'kilo',
        ['run', '--format', 'json', '--auto', '-m', `kilo/${model}`, prompt],
        {
          cwd: dir,
          env: {
            ...process.env,
            KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kiloToken } }),
            NO_COLOR: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
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

      const finish = async (exitCode) => {
        clearTimeout(killTimer);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        const stdoutLines = stdout.split('\n').filter(line => line.length > 0);
        resolve({
          exitCode,
          durationMs: Date.now() - startedAt,
          stdoutLines,
          stderrTail,
        });
      };

      child.on('error', err => {
        stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-STDERR_CAP_BYTES);
        void finish(-1);
      });
      child.on('close', code => {
        void finish(code ?? -1);
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

    if (req.method === 'POST' && req.url === '/run') {
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }

      const { model, prompt, kiloToken } = parsed ?? {};
      const timeoutMs =
        typeof parsed?.timeoutMs === 'number' && parsed.timeoutMs > 0
          ? parsed.timeoutMs
          : DEFAULT_TIMEOUT_MS;

      if (typeof model !== 'string' || typeof prompt !== 'string' || typeof kiloToken !== 'string') {
        sendJson(res, 400, { error: 'model, prompt and kiloToken are required strings' });
        return;
      }

      try {
        const result = await runCase({ model, prompt, kiloToken, timeoutMs });
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
