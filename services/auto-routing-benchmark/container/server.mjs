// Dependency-free HTTP server that runs one decider-benchmark case through the
// stable `kilo` CLI per request. Intentionally dumb: it spawns the CLI, caps
// output, and returns raw stdout lines. All event parsing happens in the
// worker (src/kilo-events.ts), not here.
//
// The Kilo user token is passed in the request body and injected only as a
// child-process env var (KILO_AUTH_CONTENT). It is never written to disk and
// never logged. Every captured child stream this server returns or delivers
// keeps whole lines only: a cap drops the line it cut, and every remaining value
// is returned with the placeholder.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3000;
const DEFAULT_TIMEOUT_MS = 180_000;
const STDOUT_CAP_BYTES = 2 * 1024 * 1024; // 2MB
const STDERR_CAP_BYTES = 4 * 1024; // 4KB tail

// The only paths the CLI sends for inference, mapped to the worker's case-inference api.
// The CLI's paths are fixed literals, so the proxy can hold an exact table instead of
// pattern-matching; anything not listed is refused locally.
const INFERENCE_GATEWAY_API = new Map([
  ['/api/gateway/v1/chat/completions', 'chat/completions'],
  ['/api/gateway/v1/responses', 'responses'],
  ['/api/gateway/v1/messages', 'messages'],
]);
// Exact catalog read routes established from the pinned CLI capture and the worker's
// catalog client: `GET /api/openrouter/models` (platform-models.ts) and the CLI's
// `/api/gateway/v1/models`. Nothing else is a setup call this runner needs.
const CATALOG_READ_PATHS = new Set(['/api/openrouter/models', '/api/gateway/v1/models']);
const CATALOG_READ_QUERY = new Set(['output_modalities']);
// A case capability is valid for 15 minutes from the signed `startedAt`; the worker is the
// authority, this only keeps a stale local grant from being used at all.
const CASE_CAPABILITY_WINDOW_MS = 15 * 60_000;
// The contract constant is `BENCHMARK_MODEL_REQUEST_ID_HEADER` in
// packages/auto-routing-contracts/src/benchmark-inference.ts. This file is plain JS, so the
// literal is repeated here with the exact same spelling; the worker rejects anything that
// is not a UUID.
const MODEL_REQUEST_ID_HEADER = 'x-kilo-benchmark-model-request-id';
// The Worker-origin-only stop marker. It is trusted only on a refusal (never on an admitted
// upstream reply), never taken from provider text, and it is never forwarded to the CLI.
const CASE_STOP_HEADER = 'x-kilo-benchmark-stop';
const ADMISSION_HEADER = 'x-kilo-benchmark-admission';
const CASE_STOP_REASONS = new Set([
  'paused',
  'no_payer',
  'cancelled',
  'not_live',
  // infra_unavailable: Worker could not verify billing/gateway before any provider call.
  // model_permanently_failed: the pair is terminally failed. Both are the shared names.
  'infra_unavailable',
  'model_permanently_failed',
]);
const PROXY_DROPPED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'expect',
  'x-kilo-benchmark-case',
  // Set by this proxy only: a CLI value must never choose the billing identity.
  'x-kilo-benchmark-model-request-id',
  // Never accepted inbound: a stop is a Worker-origin refusal marker only.
  'x-kilo-benchmark-stop',
  'x-kilo-benchmark-admission',
]);
const PROXY_BODY_CAP_BYTES = 8 * 1024 * 1024;
const PROXY_HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const PROXY_FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'x-request-id',
  'request-id',
  'retry-after',
]);

// The case currently owning the CLI lane. The container runs one case at a time, so the
// proxy always forwards for that case and its capability.
let caseProxy = null; // normalized CaseInferenceProxy
let proxyPort = null;
let proxyStart = null;

function sendJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The container is the CLI's whole API origin (`KILO_API_URL`), so the CLI keeps its fixed
// gateway paths and never holds a payer credential. This proxy holds an exact route table:
// inference goes to the worker's case-inference api with the case capability, the pinned
// catalog reads go to the platform catalog transport, and everything else is refused
// locally without touching either credential.
function proxyHeaders(req, extra) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lowered = name.toLowerCase();
    if (PROXY_DROPPED_HEADERS.has(lowered) || !PROXY_HEADER_NAME.test(lowered)) continue;
    if (typeof value !== 'string') continue;
    headers[lowered] = value;
  }
  // `extra` is built by this proxy; it is the only source of the capability, the case
  // invocation, the model-request id and (for the catalog leg) the bot credential.
  return { ...headers, ...extra };
}

function forwardResponseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    const lowered = name.toLowerCase();
    if (PROXY_FORWARDED_RESPONSE_HEADERS.has(lowered)) headers[lowered] = value;
  }
  if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  return headers;
}

function proxyTargetPath(requestUrl, api) {
  return `/case-inference/${api}`;
}

function revokeCaseProxy(proxy, reason) {
  // The Worker may already have admitted and billed this call; a CLI-triggered retry must
  // not open a second paid attempt for the same case. Only this generation is revoked, so a
  // later case on the same slot installs its own envelope.
  proxy.revoked = true;
  console.warn(JSON.stringify({ event: 'benchmark_case_proxy_revoked', reason }));
}

// A Worker refusal may name why it stopped the case. An admitted upstream reply never may,
// even if a provider echoes the header, so only a refusal's marker is trusted.
function trustedStop(response) {
  const admission = response.headers.get(ADMISSION_HEADER);
  if (admission !== null && admission !== 'refused') return null;
  const reason = response.headers.get(CASE_STOP_HEADER);
  return CASE_STOP_REASONS.has(reason) ? { reason, status: response.status } : null;
}

async function proxyRequest(req, res, proxy) {
  const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${proxyPort}`);
  const api = req.method === 'POST' ? INFERENCE_GATEWAY_API.get(requestUrl.pathname) : undefined;
  const catalogRead =
    req.method === 'GET' &&
    CATALOG_READ_PATHS.has(requestUrl.pathname) &&
    [...requestUrl.searchParams.keys()].every(name => CATALOG_READ_QUERY.has(name));
  if (api === undefined && !catalogRead) {
    // Unknown route or method: refuse locally. An alternate spelling of an inference path,
    // a setup call or a redirect target can never borrow a credential here.
    sendJson(res, 404, { error: 'benchmark proxy route not allowed' });
    return;
  }
  if (api !== undefined && proxy.revoked === true) {
    sendJson(res, 503, { error: 'benchmark case grant revoked' });
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > PROXY_BODY_CAP_BYTES) {
      sendJson(res, 413, { error: 'request body too large' });
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const upstream = api !== undefined ? proxy : proxy.catalog;
  if (!upstream) {
    sendJson(res, 503, { error: 'no benchmark upstream for this route' });
    return;
  }
  const target =
    api !== undefined
      ? new URL(proxyTargetPath(requestUrl, api), proxy.url)
      : new URL(`${requestUrl.pathname}${requestUrl.search}`, upstream.url);
  // One id per outbound model request, minted here and sent once: a CLI-supplied value is
  // stripped above, and the Worker requires a UUID for its one-time admission.
  const extra =
    api !== undefined
      ? {
          authorization: proxy.authorization,
          [proxy.invocationHeader]: proxy.invocation,
          [MODEL_REQUEST_ID_HEADER]: crypto.randomUUID(),
        }
      : { authorization: upstream.authorization };
  let response;
  try {
    response = await fetch(target, {
      method: req.method,
      headers: proxyHeaders(req, extra),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      // A redirect could carry the bot credential or the capability to another host.
      redirect: 'manual',
    });
  } catch {
    if (api !== undefined) revokeCaseProxy(proxy, 'ambiguous_transport');
    sendJson(res, 502, { error: 'benchmark upstream unreachable' });
    return;
  }
  res.writeHead(response.status, forwardResponseHeaders(response));
  // A Worker refusal may carry the trusted stop; an admitted upstream reply never does (and
  // is exempt even if the header appears), so provider text cannot pause a case.
  const stop = api !== undefined ? trustedStop(response) : null;
  if (stop !== null) {
    proxy.stop = stop;
    console.warn(
      JSON.stringify({ event: 'benchmark_case_stopped', reason: stop.reason, url: proxy.url })
    );
  }
  if (response.body === null) {
    res.end();
    return;
  }
  // Streaming, not buffering: the CLI parses an SSE reply as it arrives. A stream that
  // breaks after the headers may already be billed, so it revokes the generation too.
  try {
    for await (const chunk of response.body) {
      if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    }
  } catch {
    if (api !== undefined) revokeCaseProxy(proxy, 'ambiguous_stream');
    res.destroy();
    return;
  }
  res.end();
}

function proxyOrigin() {
  return `http://127.0.0.1:${proxyPort}`;
}

// The signed invocation carries the start of the paid generation; the capability window is
// a fixed 15 minutes from it, never an unsigned field the caller supplies.
function proxyGrantExpired(proxy) {
  const invocation = decodeCaseInvocation(proxy.invocation);
  if (invocation === null) return true;
  return Date.now() > invocation.startedAt + CASE_CAPABILITY_WINDOW_MS;
}

// Started once per container process, before the first case, and reused by every case.
async function ensureProxy() {
  if (proxyStart) return proxyStart;
  proxyStart = new Promise((resolve, reject) => {
    const proxyServer = createServer((req, res) => {
      const active = caseProxy;
      if (active === null) {
        sendJson(res, 503, { error: 'no benchmark case is running' });
        return;
      }
      if (proxyGrantExpired(active)) {
        sendJson(res, 503, { error: 'benchmark case grant expired' });
        return;
      }
      proxyRequest(req, res, active).catch(() => {
        if (!res.headersSent) sendJson(res, 502, { error: 'benchmark proxy failed' });
        else res.destroy();
      });
    });
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port;
      resolve(proxyServer);
    });
  });
  return proxyStart;
}

function decodeCaseInvocation(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(binary);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Number.isInteger(parsed.startedAt) ||
      parsed.startedAt <= 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
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

// A paid case is identified by its ledger generation, so a cancel of an older attempt
// can never touch a retry that replaced it on the same model/repetition slot. The claim
// token is deliberately not part of the identity: a chunk re-claim keeps the same paid
// call, and a pause must still stop it.
const CANCELLED_GENERATION_TTL_MS = 15 * 60_000;
const CANCELLED_GENERATIONS_MAX = 64;
// A generation whose cancel arrives before its /run request registers, or after it
// settled, is remembered briefly so a request that arrives later never starts it.
const cancelledGenerations = new Map(); // paid key -> expiresAt (insertion order)
const activeCases = new Map(); // paid key -> case run job

function paidExecutionKey(execution) {
  if (typeof execution !== 'object' || execution === null) return null;
  const { runId, model, variant, rep, caseId, attemptStartedAt } = execution;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  if (typeof variant !== 'string') return null;
  if (!Number.isInteger(rep)) return null;
  if (typeof caseId !== 'string' || caseId.length === 0) return null;
  if (!Number.isInteger(attemptStartedAt)) return null;
  return JSON.stringify([runId, model, variant, rep, caseId, attemptStartedAt]);
}

function markCancelledGeneration(key) {
  const now = Date.now();
  for (const [candidate, expiresAt] of cancelledGenerations) {
    if (expiresAt > now) break; // insertion order is expiry order
    cancelledGenerations.delete(candidate);
  }
  cancelledGenerations.delete(key);
  cancelledGenerations.set(key, now + CANCELLED_GENERATION_TTL_MS);
  while (cancelledGenerations.size > CANCELLED_GENERATIONS_MAX) {
    cancelledGenerations.delete(cancelledGenerations.keys().next().value);
  }
}

// One accepted case's cancellation state. Until a child exists, cancelling only marks the
// job, which the serialized start checks; once it exists, `stop` kills its process group.
// A generation gets at most one job: a second request for the same paid call is refused
// (`refused`, no result reported, so it can never clear the live call's ledger) rather
// than allowed to spend twice, and a tombstoned generation never starts.
function createCaseRunJob(execution) {
  const key = paidExecutionKey(execution);
  if (key === null) return null;
  if (activeCases.has(key)) {
    return { key, cancelled: true, refused: true, stop: null, attach() {}, release() {} };
  }
  if (cancelledGenerations.has(key)) {
    return { key, cancelled: true, refused: false, stop: null, attach() {}, release() {} };
  }
  const job = {
    key,
    cancelled: false,
    refused: false,
    stop: null,
    attach(stop) {
      this.stop = stop;
      if (this.cancelled) stop();
    },
    release() {
      if (activeCases.get(key) === this) activeCases.delete(key);
    },
  };
  activeCases.set(key, job);
  return job;
}

// Returns 'killed' for a stopped subprocess, 'dequeued' for an accepted case that never
// started, and 'not_running' when nothing of that generation is active (including a
// stale generation, which is remembered but never allowed to affect another one).
function cancelCase(execution) {
  const key = paidExecutionKey(execution);
  if (key === null) return null;
  const job = activeCases.get(key);
  if (job) {
    if (job.stop) return job.stop() ? 'killed' : 'not_running';
    job.cancelled = true;
    return 'dequeued';
  }
  markCancelledGeneration(key);
  return 'not_running';
}

// A case accepted before SIGTERM or a cancel, but not yet spawned, never reaches a provider.
// The case's proxy grant is installed only once this case owns the CLI lane, so a queued
// case can never swap the capability out from under the running one.
function runCaseSerialized(params, job, proxy) {
  return serializeCli(async () => {
    if (stopRequested) throw new NotStartedError('container is stopping', 'shutdown');
    if (job?.cancelled) throw new NotStartedError('case cancelled', 'cancelled');
    if (proxy === null) return runCase(params, job);
    await ensureProxy();
    caseProxy = proxy;
    try {
      return await runCase(params, job);
    } finally {
      if (caseProxy === proxy) caseProxy = null;
    }
  });
}

// The worker repeats a run that ends before its first event; a cancelled run must never be
// reported as never started once it spawned, so this only decides whether its output is
// worth carrying in the terminal cancellation marker.
function hasEmittedEvent(stdoutLines) {
  for (const line of stdoutLines) {
    try {
      const event = JSON.parse(line);
      if (typeof event === 'object' && event !== null && typeof event.type === 'string') {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

function parseCaseProxy(value) {
  if (typeof value !== 'object' || value === null) return null;
  const { url, authorization, invocation, invocationHeader, catalog } = value;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) return null;
  if (typeof invocation !== 'string' || invocation.length === 0) return null;
  const header = typeof invocationHeader === 'string' ? invocationHeader.toLowerCase() : '';
  if (!PROXY_HEADER_NAME.test(header)) return null;
  if (decodeCaseInvocation(invocation) === null) return null;
  let catalogTransport = null;
  if (catalog !== undefined && catalog !== null) {
    if (
      typeof catalog !== 'object' ||
      typeof catalog.url !== 'string' ||
      !/^https?:\/\//.test(catalog.url) ||
      typeof catalog.authorization !== 'string' ||
      catalog.authorization.length === 0
    ) {
      return null;
    }
    catalogTransport = { url: catalog.url, authorization: catalog.authorization };
  }
  return {
    url,
    authorization,
    invocation,
    invocationHeader: header,
    catalog: catalogTransport,
    revoked: false,
    stop: null,
  };
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
function runCase(
  { model, prompt, isolated, kiloToken, kiloApiUrl, orgId, timeoutMs, variant, context },
  job
) {
  const resolvedOrgId = typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
  const args = ['run', '--format', 'json', '--auto', '-m', `kilo/${model}`];
  if (typeof variant === 'string' && variant.length > 0) args.push('--variant', variant);
  // With a case proxy the CLI's API origin is the local reverse proxy, so the CLI env
  // carries no payer token at all; its auth header is a value the proxy strips before it
  // forwards, and the real case capability is added there. Without a proxy (local offline
  // runs, admin debug) the previous direct behaviour is unchanged.
  const proxy = caseProxy;
  const runEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: JSON.stringify({
      kilo: {
        type: 'api',
        key: proxy ? 'benchmark-proxy' : kiloToken,
        ...(resolvedOrgId ? { organizationId: resolvedOrgId } : {}),
      },
    }),
    KILO_API_URL: proxy ? proxyOrigin() : kiloApiUrl,
    KILO_DISABLE_SESSION_INGEST: '1',
    ...(resolvedOrgId ? { KILO_ORG_ID: resolvedOrgId } : {}),
    NO_COLOR: '1',
  };
  return withWorkspace(async cwd => {
    const env = isolated ? { ...runEnv, PWD: cwd } : runEnv;
    return runCli({ args, cwd, stdin: prompt, env, timeoutMs, kiloToken, context }, job);
  });
}

// Nothing the child writes reaches a caller unread: each captured stream is scrubbed
// with the one credential this server injects before it is returned or delivered.
function redactToken(text, kiloToken) {
  return typeof kiloToken === 'string' && kiloToken.length > 0
    ? text.split(kiloToken).join('[redacted]')
    : text;
}

// A cap ends inside a line, so a capped edge keeps whole lines only and drops the line
// the cap cut.
function dropCutLine(text, edge) {
  const cut = edge === 'end' ? text.lastIndexOf('\n') : text.indexOf('\n');
  if (cut === -1) return '';
  return edge === 'end' ? text.slice(0, cut + 1) : text.slice(cut + 1);
}

async function runCli({ args, cwd, stdin, env, timeoutMs, kiloToken, context }, job) {
  const startedAt = Date.now();
  const result = await new Promise(resolve => {
    let timedOut = false;
    let cancelled = false;
    let stdout = '';
    let stdoutTruncated = false;
    let stderrTail = '';
    // A case cancelled while it waited for the CLI lane must not spawn at all.
    if (job?.cancelled) {
      throw new NotStartedError('case cancelled', 'cancelled');
    }
    let stderrTruncated = false;
    // The kilo wrapper spawns a grandchild; a timeout or a cancel must kill its whole group.
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
      const retainedStdout = stdoutTruncated ? dropCutLine(stdout, 'end') : stdout;
      const retainedStderr = stderrTruncated ? dropCutLine(stderrTail, 'start') : stderrTail;
      resolve({
        exitCode,
        stdoutLines: retainedStdout
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => redactToken(line, kiloToken)),
        stderrTail: redactToken(retainedStderr, kiloToken),
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
      });
    };
    // A surviving grandchild can keep the pipes open after the CLI exits.
    const finishAfterExit = exitCode => {
      if (finished || finishTimer) return;
      finishTimer = setTimeout(() => finish(exitCode), 5_000);
      finishTimer.unref();
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      finishAfterExit(-1);
      killGroup();
    }, timeoutMs);
    if (job) {
      job.attach(() => {
        if (finished) return false;
        cancelled = true;
        finishAfterExit(-1);
        killGroup();
        return true;
      });
    }

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
      const text = chunk.toString('utf8');
      if (stderrTail.length + text.length > STDERR_CAP_BYTES) stderrTruncated = true;
      stderrTail = (stderrTail + text).slice(-STDERR_CAP_BYTES);
    });
    child.on('error', error => {
      const text = `\nspawn error: ${error.message}`;
      if (stderrTail.length + text.length > STDERR_CAP_BYTES) stderrTruncated = true;
      stderrTail = (stderrTail + text).slice(-STDERR_CAP_BYTES);
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
    const sendResponse = (status, body, headers) => {
      try {
        if (headers) sendJson(res, status, body, headers);
        else sendJson(res, status, body);
      } catch {
        finishRequest();
      }
    };
    void (async () => {
      // Cancellation outlives shutdown: a paused payer must still stop a case that is
      // already running while the container is draining.
      if (req.method === 'POST' && req.url === '/cancel') {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendResponse(400, { error: 'invalid JSON body' });
          return;
        }
        const execution = parsed?.execution;
        const state = cancelCase(execution);
        if (state === null) {
          sendResponse(400, {
            error:
              'execution with runId, model, variant, rep, caseId and attemptStartedAt is required',
          });
          return;
        }
        logCaseEvent(
          'benchmark_container_case_cancelled',
          {
            runId: typeof execution?.runId === 'string' ? execution.runId : null,
            model: typeof execution?.model === 'string' ? execution.model : null,
            variant: typeof execution?.variant === 'string' ? execution.variant : '',
            rep: Number.isInteger(execution?.rep) ? execution.rep : null,
            caseId: typeof execution?.caseId === 'string' ? execution.caseId : null,
            attemptStartedAt: Number.isInteger(execution?.attemptStartedAt)
              ? execution.attemptStartedAt
              : null,
            retried: execution?.retried === true,
          },
          { outcome: 'cancelled', category: state }
        );
        sendResponse(200, { cancelled: state !== 'not_running', state });
        return;
      }
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

        const {
          model,
          prompt,
          kiloToken,
          kiloApiUrl,
          orgId,
          variant,
          resultCallback,
          isolated,
          inferenceProxy,
        } = parsed ?? {};
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
        // Validate the case envelope BEFORE registering the job. `createCaseRunJob` inserts
        // this generation into `activeCases`, and rejecting after that point stranded the
        // entry with no release and no `not_started` delivery: the generation then looked
        // active forever, so every later cancel reported 'dequeued' and every retry of the
        // same case was refused as a duplicate. Nothing here touches state on failure.
        let proxy = null;
        if (inferenceProxy !== undefined && inferenceProxy !== null) {
          proxy = parseCaseProxy(inferenceProxy);
          if (proxy === null) {
            sendResponse(400, { error: 'inferenceProxy is malformed' });
            return;
          }
        }
        const job = createCaseRunJob(callback?.execution);
        logCaseEvent('benchmark_container_case_accepted', context, {
          outcome: 'pending',
          category: 'queued',
        });
        if (callback) pendingDeliveries += 1;
        try {
          let outcome;
          let failure = null;
          let cancelled = false;
          let stop = null;
          let category;
          try {
            if (stopRequested) throw new NotStartedError('container is stopping', 'shutdown');
            const response = await runCaseSerialized(
              {
                model,
                prompt,
                isolated: isolated === true,
                kiloToken,
                kiloApiUrl,
                orgId,
                timeoutMs,
                variant,
                context,
              },
              job,
              proxy
            );
            if (response.cancelled) {
              cancelled = true;
              category = 'cancelled';
              // A spawned call may already have reached a provider, so it is reported as a
              // terminal cancellation, never as not_started (which would let the worker
              // reschedule it as a fresh paid attempt). Output it already produced rides
              // along for grading; a call without output is still marked as spawned.
              outcome = {
                kind: 'cancelled',
                spawned: true,
                ...(hasEmittedEvent(response.stdoutLines) ? { response } : {}),
              };
            } else {
              // The Worker stopped this case (pause, no payer, infrastructure, permanently
              // failed). It is a trusted refusal marker, so it rides with the result
              // independent of cost or stderr text.
              if (proxy?.stop) stop = proxy.stop;
              outcome = {
                kind: 'completed',
                response,
                ...(stop === null ? {} : { stop }),
              };
              category = response.timedOut
                ? 'timeout'
                : response.exitCode === 0
                  ? 'success'
                  : 'cli_error';
            }
          } catch (err) {
            // A case may only be reported as never started when no child was spawned.
            // `failure` holds a parent-side message about workspace or process setup, not text
            // captured from the child's streams, so the placeholder substitution does not apply.
            if (err instanceof NotStartedError) {
              outcome = { kind: 'not_started' };
              category = err.category;
              if (err.category === 'cancelled') cancelled = true;
              else if (!stopRequested) failure = err.message;
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
            // The trusted stop rides on the HTTP answer too, so the caller classifies the case
            // without parsing CLI stderr or provider text.
            const stopHeaders = stop === null ? null : { [CASE_STOP_HEADER]: stop.reason };
            if (cancelled) {
              // The stopped case's outcome is already reported to the callback; the caller
              // gets a typed cancellation instead of a result, so the worker neither grades
              // it as a failure nor retries it as a paid attempt.
              sendResponse(
                409,
                {
                  error: job?.refused ? 'case already running' : 'case cancelled',
                  cancelled: true,
                  ...(stop === null ? {} : { stop }),
                },
                stopHeaders
              );
            } else if (outcome.kind === 'completed') {
              sendResponse(
                200,
                stop === null ? outcome.response : { ...outcome.response, stop },
                stopHeaders
              );
            } else if (failure) sendResponse(500, { error: failure });
            else sendResponse(503, { error: 'container is stopping' });
            if (callback && !responseSettled) {
              responseDeadline = setTimeout(() => {
                finishRequest();
                res.destroy();
              }, RESPONSE_COMPLETION_TIMEOUT_MS);
              responseDeadline.unref();
            }
          };
          if (
            callback &&
            job?.refused !== true &&
            (outcome.kind === 'completed' ||
              outcome.kind === 'not_started' ||
              outcome.kind === 'cancelled')
          ) {
            await deliverResult(callback, outcome, context, respond);
          }
          respond();
        } finally {
          if (proxy !== null && caseProxy === proxy) caseProxy = null;
          job?.release();
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
