#!/usr/bin/env node
/**
 * server.mjs — in-container HTTP server for the kilo-context pipeline.
 *
 * Listens on PORT (default 8080).
 *
 * Routes:
 *   POST /run    — start the pipeline, stream stdout/stderr as chunked response.
 *                  Body: { env?: Record<string,string> }
 *                  Signals completion with the line: __PIPELINE_COMPLETE__ <status> <exitCode>
 *   GET  /health — liveness check: { ok: true, running: boolean }
 *
 * Only one pipeline run at a time. Concurrent POST /run calls receive 409.
 * The container should be destroyed by the Orchestrator after the run completes.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const APP_DIR = '/app';

/** True while a pipeline subprocess is running. Prevents concurrent runs. */
let isRunning = false;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running: isRunning }));
    return;
  }

  // ── POST /run ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/run') {
    if (isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pipeline already running' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      /** @type {{ env?: Record<string,string> }} */
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }

      // Merge request-supplied env vars on top of process.env.
      // This lets the Orchestrator inject KILO_API_TOKEN, SLACK_USER_TOKEN, etc.
      const envOverrides = parsed.env ?? {};
      const kbRoot = envOverrides.KB_ROOT ?? process.env.KB_ROOT ?? '/workspace/kb';

      // Ensure KB_ROOT directory exists.
      if (!existsSync(kbRoot)) {
        try {
          mkdirSync(kbRoot, { recursive: true });
          console.log(`[pipeline-server] Created KB_ROOT: ${kbRoot}`);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Failed to create KB_ROOT: ${err.message}` }));
          return;
        }
      }

      isRunning = true;
      console.log(`[pipeline-server] Starting pipeline run. KB_ROOT=${kbRoot}`);

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });

      /** Write to the response, ignoring errors if the client disconnected. */
      const write = (/** @type {Buffer|string} */ data) => {
        try { res.write(data); } catch { /* client disconnected — ignore */ }
      };

      // Run: npm run pull && npm run update && npm run publish
      // - All three steps run sequentially via shell &&.
      // - cwd=/app (where package.json lives with the npm scripts).
      // - KB_ROOT and credentials are passed via the merged env.
      const subprocess = spawn(
        '/bin/sh',
        ['-c', 'npm run pull && npm run update && npm run publish'],
        {
          cwd: APP_DIR,
          env: {
            ...process.env,
            ...envOverrides,
            KB_ROOT: kbRoot,
            HOME: '/root',
            PATH: process.env.PATH,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      subprocess.stdout.on('data', data => write(data));
      subprocess.stderr.on('data', data => write(data));

      subprocess.on('error', err => {
        write(`\n[pipeline-server] Subprocess error: ${err.message}\n`);
      });

      subprocess.on('close', exitCode => {
        const status = exitCode === 0 ? 'success' : 'failed';
        const code = exitCode ?? -1;
        console.log(`[pipeline-server] Pipeline ${status} (exit ${code})`);
        // Emit a sentinel line the Orchestrator can match on to determine status.
        write(`\n__PIPELINE_COMPLETE__ ${status} ${code}\n`);
        try { res.end(); } catch { /* ignore */ }
        isRunning = false;
      });
    });
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pipeline-server] Listening on port ${PORT}`);
});
