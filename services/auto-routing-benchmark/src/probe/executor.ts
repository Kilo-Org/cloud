import type { ProbeCase } from '../datasets/probe-cases';
import { DECIDER_CLI_TIMEOUT_MS, type CliRunResult } from '../cli-runner';
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

// The CLI's session id shape (`ses_` + 12 hex + 14 base62). The gateway reads it for
// session affinity only; the probe sends one id per request.
function probeSessionId(now: number): string {
  return `ses_${(now * 0x1000).toString(16).padStart(12, '0')}${randomBase62(14)}`;
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

export function probeHeaders(
  template: ProbeTemplate,
  values: { kiloToken: string; orgId: string | null; sessionId: string; machineId: string }
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(template.headers)) {
    const source = DYNAMIC_HEADERS[name];
    // Transport headers are per connection (the capture records them empty); fetch sets them.
    if (source === undefined && value === '') continue;
    headers[name] =
      source === 'authorization'
        ? `Bearer ${values.kiloToken}`
        : source === 'apiKey'
          ? values.kiloToken
          : source === 'organization'
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

function emptyTools() {
  return { calls: 0, names: [], steps: 0, finalFinishReason: null };
}

/** A reply-less result the existing unbilled/transient classification understands. */
function unbilledFailure(stderr: string, latencyMs: number): CliRunResult {
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

/**
 * Runs one probe case straight through the gateway: no CLI, no container. The request is
 * the captured template plus the transcript's history up to the cut, so the reply is the
 * model's own next move after a tool result.
 */
export async function runProbeCaseViaGateway(request: ProbeRunRequest): Promise<CliRunResult> {
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
          kiloToken: request.kiloToken,
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
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    const stderr = `HTTP ${response.status} ${detail}`;
    if (UNKNOWN_MODEL_STATUS.has(response.status)) {
      return { ...unbilledFailure(stderr, latencyMs), unavailableModelId: request.model };
    }
    return unbilledFailure(stderr, latencyMs);
  }

  const read = await readStream(response);
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
  if (reply.errorMessage !== null && reply.toolCalls.length === 0 && reply.text.length === 0) {
    return unbilledFailure(`provider error: ${reply.errorMessage}`, latencyMs);
  }

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
    exitCode: 0,
    stderrTail: reply.errorMessage ?? '',
    eventCount: reply.eventCount,
    lastEventTypes: [...reply.lastEventTypes],
    tools: toolsOf(reply),
    timedOut: false,
  };
}

/** The timeout a probe request honours, shared with the CLI container path. */
export const PROBE_TIMEOUT_MS = DECIDER_CLI_TIMEOUT_MS;
const PROBE_TIMEOUT_DIAGNOSTIC = `probe request timed out after ${PROBE_TIMEOUT_MS}ms`;
