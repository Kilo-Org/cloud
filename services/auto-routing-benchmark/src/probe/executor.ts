import type { ProbeCase } from '../datasets/probe-cases';
import {
  DECIDER_CLI_TIMEOUT_MS,
  PROBE_GATEWAY_ENDPOINTS,
  fetchProbeThroughRunner,
  trustedCaseStop,
  type BenchmarkCaseStop,
  type CliRunResult,
  type CaseInferenceProxy,
  type PaidLaunchExecutionKey,
  type ProbeGatewayEndpoint,
} from '../cli-runner';
import { catalogUsageCostUsd, type CatalogModel } from '../platform-models';
import { probeFamily } from './family';
import { parseProbeStream, type ProbeReply } from './reply';
import { probeRequestBody, probeTemplate, type ProbeTemplate } from './request';

/** The worker cannot build this model's request at all: retrying cannot change that. */
export class BenchmarkProbeFamilyError extends Error {
  constructor(
    readonly reason: string,
    readonly familyKey: string
  ) {
    super(reason);
    this.name = 'BenchmarkProbeFamilyError';
  }
}

/** A 400/404/422 means the gateway does not serve this model; the entry fails instead. */
const UNKNOWN_MODEL_STATUS = new Set([400, 404, 422]);

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(byte => BASE62[byte % BASE62.length]).join('');
}

// The CLI's session id shape (`ses_` + 12 hex + 14 base62). The hex part is the low 48 bits
// of `Date.now() * 0x1000`, as `@opencode-ai/schema/identifier` builds it; the gateway reads
// the id for session affinity only, so one per request is enough.
function probeSessionId(now: number): string {
  const time = (now * 0x1000) % 0x1000000000000;
  return `ses_${time.toString(16).padStart(12, '0')}${randomBase62(14)}`;
}

function probeMachineId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type HeaderSource = 'authorization' | 'apiKey' | 'organization' | 'session' | 'machine';

// Headers whose value is per run. Everything else a template lists is sent verbatim.
const DYNAMIC_HEADERS: Readonly<Record<string, HeaderSource>> = {
  authorization: 'authorization',
  // The Anthropic SDK authenticates with the bare key in `x-api-key`.
  'x-api-key': 'apiKey',
  'x-kilocode-organizationid': 'organization',
  'x-session-id': 'session',
  'x-session-affinity': 'session',
  'x-kilocode-taskid': 'session',
  'x-kilocode-machineid': 'machine',
};

/**
 * The template's headers with this run's values. A `null` token means the transport
 * authenticates the request itself (the runner's case capability), so no credential header
 * is built at all.
 */
export function probeHeaders(
  template: ProbeTemplate,
  values: { kiloToken: string | null; orgId: string | null; sessionId: string; machineId: string }
): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = values.kiloToken;
  for (const [name, value] of Object.entries(template.headers)) {
    const source = DYNAMIC_HEADERS[name];
    // Transport headers are per connection (the capture records them empty); fetch sets them.
    if (source === undefined && value === '') continue;
    if (source === 'authorization' || source === 'apiKey') {
      if (token !== null) headers[name] = source === 'authorization' ? `Bearer ${token}` : token;
      continue;
    }
    headers[name] =
      source === 'organization'
        ? (values.orgId ?? '')
        : source === 'session'
          ? values.sessionId
          : source === 'machine'
            ? values.machineId
            : value;
  }
  return headers;
}

function effortOf(model: CatalogModel, variant: string | null): string | null {
  if (variant === null) return null;
  const effort = model.opencode?.variants?.[variant]?.reasoning?.effort;
  return effort ?? null;
}

export type ProbeRunRequest = {
  model: string;
  variant: string | null;
  benchCase: ProbeCase;
  catalogModel: CatalogModel;
  kiloToken: string;
  kiloApiUrl: string;
  orgId: string | null;
  fetchImpl?: typeof fetch;
  now?: number;
};

/** A probe request without its credential: the cancellable runner path sends none. */
type ProbeRequestFields = Omit<ProbeRunRequest, 'kiloToken'>;

function emptyTools() {
  return { calls: 0, names: [], steps: 0, finalFinishReason: null };
}

/** A reply-less result the existing unbilled/transient classification understands. */
function unbilledFailure(
  stderr: string,
  latencyMs: number,
  stop?: BenchmarkCaseStop
): CliRunResult {
  return {
    text: '',
    costUsd: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    latencyMs,
    exitCode: 1,
    stderrTail: stderr,
    eventCount: 0,
    lastEventTypes: ['error'],
    tools: emptyTools(),
    timedOut: false,
    ...(stop === undefined ? {} : { stop }),
  };
}

function toolsOf(reply: ProbeReply) {
  const names: string[] = [];
  for (const call of reply.toolCalls) if (!names.includes(call.name)) names.push(call.name);
  return {
    calls: reply.toolCalls.length,
    names,
    steps: reply.toolCalls.length > 0 || reply.text.length > 0 ? 1 : 0,
    finalFinishReason: reply.finishReason,
  };
}

type StreamRead = { body: string; failure: unknown };

async function readStream(response: Response): Promise<StreamRead> {
  if (!response.body) return { body: await response.text(), failure: null };
  // A fetch body always reads as byte chunks; the lib types the reader loosely here.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return { body, failure: null };
  } catch (error) {
    return { body: body + decoder.decode(), failure: error };
  }
}

// `AbortSignal.timeout()` rejects with a DOMException, which is not an `Error` in Node or a
// worker, so the rejection's name and the signal's own state are the timeout evidence.
function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const { name } = error;
  return name === 'TimeoutError' || name === 'AbortError';
}

function measuredReply(
  reply: ProbeReply,
  request: ProbeRequestFields,
  latencyMs: number,
  exitCode: number
): CliRunResult {
  return {
    text: reply.text,
    // The gateway bills every call and usually reports the cost; when it leaves the cost out,
    // price the reported tokens at the run's catalog rates rather than recording none.
    costUsd: reply.costUsd ?? catalogUsageCostUsd(request.catalogModel, reply),
    inputTokens: reply.inputTokens,
    cachedInputTokens: reply.cachedInputTokens,
    outputTokens: reply.outputTokens,
    reasoningTokens: reply.reasoningTokens,
    latencyMs,
    exitCode,
    stderrTail: reply.errorMessage ?? '',
    eventCount: reply.eventCount,
    lastEventTypes: [...reply.lastEventTypes],
    tools: toolsOf(reply),
    timedOut: false,
  };
}

/**
 * Runs one probe case straight through the gateway: no CLI, no container. The request is
 * the captured template plus the transcript's history up to the cut, so the reply is the
 * model's own next move after a tool result.
 */
export async function runProbeCaseViaGateway(request: ProbeRunRequest): Promise<CliRunResult> {
  return runProbe(request, request.kiloToken);
}

async function runProbe(
  request: ProbeRequestFields,
  kiloToken: string | null
): Promise<CliRunResult> {
  const family = probeFamily(request.catalogModel);
  const resolved = probeTemplate(family);
  if ('unsupportedReason' in resolved) {
    throw new BenchmarkProbeFamilyError(resolved.unsupportedReason, family.key);
  }
  const { template } = resolved;
  const startedAt = request.now ?? Date.now();
  const sessionId = probeSessionId(startedAt);
  const body = probeRequestBody({
    template,
    model: request.model,
    description: request.catalogModel.description ?? null,
    effort: effortOf(request.catalogModel, request.variant),
    transcript: request.benchCase.probe.transcript,
    cutAfterStep: request.benchCase.probe.cutAfterStep,
    today: new Date(startedAt).toDateString(),
  });
  const path =
    template.endpoint === 'responses'
      ? '/api/gateway/v1/responses'
      : template.endpoint === 'anthropic'
        ? '/api/gateway/v1/messages'
        : '/api/gateway/v1/chat/completions';
  const url = `${request.kiloApiUrl.replace(/\/+$/, '')}${path}`;
  const fetchImpl = request.fetchImpl ?? fetch;

  let response: Response;
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...probeHeaders(template, {
          kiloToken,
          orgId: request.orgId,
          sessionId,
          machineId: probeMachineId(),
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (!isTimeout(error, signal)) throw error;
    return { ...unbilledFailure(PROBE_TIMEOUT_DIAGNOSTIC, Date.now() - startedAt), timedOut: true };
  }
  // A Worker refusal carries a trusted stop; an admitted upstream reply never does, so a
  // provider body cannot stop a case. Reading it here is what keeps a payment refusal from
  // being graded as a model failure: without the stop, the caller below sees an ordinary
  // unbilled HTTP failure and records a zero against the model.
  const stop = trustedCaseStop(response);
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    const latencyMs = Date.now() - startedAt;
    const stderr = `HTTP ${response.status} ${detail}`;
    // A stop names why the Worker ended the case, so it wins over the status heuristic:
    // `model_permanently_failed` must never be reported as an unknown-model retry, and a
    // refusal must not depend on which status happened to carry it.
    if (stop !== null) return unbilledFailure(stderr, latencyMs, stop);
    if (UNKNOWN_MODEL_STATUS.has(response.status)) {
      return { ...unbilledFailure(stderr, latencyMs), unavailableModelId: request.model };
    }
    return unbilledFailure(stderr, latencyMs);
  }

  if (stop !== null) {
    // A Worker refusal is never a measurement, whatever status carried it. This cannot
    // happen on the current wire (refusals are non-2xx), but grading it as a reply would
    // silently convert a funding stop into a model outcome, so it fails closed here too.
    return unbilledFailure(`HTTP ${response.status}`, Date.now() - startedAt, stop);
  }

  const read = await readStream(response);
  const latencyMs = Date.now() - startedAt;
  const reply = parseProbeStream(template.endpoint, read.body);
  const billed = (reply.costUsd ?? 0) > 0 || (reply.outputTokens ?? 0) > 0;
  const produced = billed || reply.text.length > 0 || reply.toolCalls.length > 0;
  if (read.failure !== null) {
    if (isTimeout(read.failure, signal) && !produced) {
      return { ...unbilledFailure(PROBE_TIMEOUT_DIAGNOSTIC, latencyMs), timedOut: true };
    }
    // The gateway may already have billed a generation whose output we cannot grade.
    throw new Error(
      `probe stream failed after the request was accepted: ${
        read.failure instanceof Error ? read.failure.message : JSON.stringify(read.failure)
      }`
    );
  }
  if (!reply.terminal) {
    if (!produced) {
      return unbilledFailure(
        `HTTP 502 probe stream ended without a reply${reply.errorMessage ? `: ${reply.errorMessage}` : ''}`,
        latencyMs
      );
    }
    throw new Error('probe stream was cut after the gateway billed for output');
  }
  if (reply.errorMessage !== null) {
    const diagnostic = `provider error: ${reply.errorMessage}`;
    // A terminal provider error ends the generation wherever it landed: items a failed
    // generation emitted before it are not a completed turn, so they never grade as one.
    // A billed error keeps its cost and tokens in the ledger and the case is a failure
    // instead of a free retry; an unbilled one stays transient.
    if (!billed) return unbilledFailure(diagnostic, latencyMs);
    return { ...measuredReply(reply, request, latencyMs, 1), stderrTail: diagnostic };
  }

  return measuredReply(reply, request, latencyMs, 0);
}

/** The timeout a probe request honours, shared with the CLI container path. */
export const PROBE_TIMEOUT_MS = DECIDER_CLI_TIMEOUT_MS;
const PROBE_TIMEOUT_DIAGNOSTIC = `probe request timed out after ${PROBE_TIMEOUT_MS}ms`;

const GATEWAY_PATHS: Record<ProbeGatewayEndpoint, string> = {
  'chat/completions': '/api/gateway/v1/chat/completions',
  responses: '/api/gateway/v1/responses',
  messages: '/api/gateway/v1/messages',
};

function probeEndpointForPath(pathname: string): ProbeGatewayEndpoint | null {
  for (const endpoint of PROBE_GATEWAY_ENDPOINTS) {
    if (GATEWAY_PATHS[endpoint] === pathname) return endpoint;
  }
  return null;
}

// The runner object cannot be handed an AbortSignal. Its generation controller is reached
// through `cancelDeciderCase`; this only relays the caller's own timeout so the result is
// classified the same way it was when the probe fetched the gateway directly.
function abortable<T>(answer: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === null || signal === undefined) return answer;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
  }
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  answer.then(
    value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    },
    error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  );
  return promise;
}

export type CancellableProbeRequest = ProbeRequestFields & {
  instanceName: string;
  execution: PaidLaunchExecutionKey;
  /** Same case-scoped transport the CLI proxy uses; no provider credential is passed. */
  inference: CaseInferenceProxy;
};

/**
 * Runs one probe case through the worker's case-inference route, proxied by the per-slot
 * runner Durable Object so the paid generation can be cancelled from another isolate.
 *
 * `instanceName` and `execution` are the same pair `cancelDeciderCase` receives, so a pause
 * aborts this exact request. `inference` is the capability envelope the scheduler issued
 * from the canonical claim (same issue path as the CLI), so the request is attributable to
 * the same generation and cap, and neither the executor's template headers nor any provider
 * token reach the gateway; the probe holds no Kilo token at all. The object checks the
 * canonical paid generation before fetching, failing closed. A cancelled probe throws
 * `BenchmarkCaseCancelledError`; a probe whose generation is no longer live, or whose
 * admission cannot be verified, throws `BenchmarkCaseNotStartedError` with no provider work.
 * Both are terminal for the paid start; a caller timeout still classifies as a timed-out
 * probe.
 */
export async function runCancellableProbeCase(
  env: Env,
  params: CancellableProbeRequest
): Promise<CliRunResult> {
  const { instanceName, execution, inference, ...request } = params;
  return runProbe(
    {
      ...request,
      fetchImpl: async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        );
        const endpoint = probeEndpointForPath(url.pathname);
        if (endpoint === null) throw new Error(`probe endpoint not allowed: ${url.pathname}`);
        const body = init?.body;
        if (typeof body !== 'string') throw new Error('probe body must be serialized JSON');
        return abortable(
          fetchProbeThroughRunner(env, {
            instanceName,
            execution,
            endpoint,
            inference,
            body,
          }),
          init?.signal
        );
      },
    },
    null
  );
}
