import { stripVTControlCharacters } from 'node:util';
import * as z from 'zod';
import { BENCHMARK_CASE_HEADER } from './case-inference-capability';
import type { PaidExecutionKey } from './scheduler';
import { parseKiloRunEvents, type ToolEvidence } from './kilo-events';
import type { DeciderCase } from './datasets/decider-cases';
import { taskPrompt } from './decider-prompt';

export type CliRunResult = {
  text: string;
  costUsd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  latencyMs: number;
  exitCode: number;
  stderrTail: string;
  eventCount: number;
  lastEventTypes: string[];
  tools: ToolEvidence;
  timedOut: boolean;
  unavailableModelId?: string;
  /**
   * Why the case was stopped by the Worker (pause, no payer, superseded), independent of any
   * provider output, cost or stderr text. Only the Worker-origin response marker produces it;
   * an admitted upstream response can never set it. Absent means the case ended normally.
   */
  stop?: BenchmarkCaseStop;
};

/**
 * Header the Worker sets on its own case-inference refusals, and only there. The runner
 * proxy trusts it only when the response is not an admitted upstream reply, strips it (and
 * the admission header) from anything the CLI sends, and records it on the run result. A
 * provider body containing the same text is never a stop.
 */
export const BENCHMARK_CASE_STOP_HEADER = 'x-kilo-benchmark-stop';

/** The narrow stop union: every value means "end this case without a paid retry". */
export const BENCHMARK_CASE_STOP_REASONS = [
  'paused',
  'no_payer',
  'cancelled',
  'not_live',
  // The Worker could not verify its own billing or gateway infrastructure before any
  // provider call. Transient: no grade, no pause, no charge, no ledger clear; the lane is
  // re-admitted normally. `costUsd` stays truthful so a caller can tell whether this attempt
  // already billed.
  'infra_unavailable',
  // The exact model is permanently failed. Terminal for the pair without a new attempt or
  // another permanent-failure vote.
  'model_permanently_failed',
] as const;
export type BenchmarkCaseStopReason = (typeof BENCHMARK_CASE_STOP_REASONS)[number];
export type BenchmarkCaseStop = { reason: BenchmarkCaseStopReason; status: number };

export function isBenchmarkCaseStopReason(value: unknown): value is BenchmarkCaseStopReason {
  return BENCHMARK_CASE_STOP_REASONS.some(reason => reason === value);
}

/**
 * The trusted stop a response carries, or null.
 *
 * The marker is honored only when the response is *not* an admitted upstream reply: a reply
 * from the gateway always carries `x-kilo-benchmark-admission`, so an upstream echo of the
 * stop header is exempt. A response without that header can only be one the Worker's
 * case-inference route originated (refusals do not pass through the gateway), which is why
 * an absent header is allowed for those. If the gateway ever answers an admitted call
 * without its admission header, this rule must change together with the wire contract.
 */
export function trustedCaseStop(response: Response): BenchmarkCaseStop | null {
  const admission = response.headers.get('x-kilo-benchmark-admission');
  if (admission !== null && admission !== 'refused') return null;
  const value = response.headers.get(BENCHMARK_CASE_STOP_HEADER);
  return isBenchmarkCaseStopReason(value) ? { reason: value, status: response.status } : null;
}

export type AttemptUsage = Pick<
  CliRunResult,
  'costUsd' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens'
>;

// A retried case bills both attempts, so its cost and token totals cover both.
export function addPriorAttempt(result: CliRunResult, prior: AttemptUsage): void {
  const add = (current: number | null, previous: number | null) =>
    current === null && previous === null ? null : (current ?? 0) + (previous ?? 0);
  result.costUsd = add(result.costUsd, prior.costUsd);
  result.inputTokens = add(result.inputTokens, prior.inputTokens);
  result.cachedInputTokens = add(result.cachedInputTokens, prior.cachedInputTokens);
  result.outputTokens = add(result.outputTokens, prior.outputTokens);
  result.reasoningTokens = add(result.reasoningTokens, prior.reasoningTokens);
}

export const DECIDER_CLI_TIMEOUT_MS = 180_000;

/**
 * The exact text `kilo run` sends to the model for a decider case: the container writes it
 * to the CLI's stdin, which the CLI uses verbatim. Long-context cases carry their generated
 * workspace snapshot, as the offline sweep and candidate screen send them. The CLI has no
 * system-prompt flag, so the system prompt is folded in. The platform container and client
 * evals (ADR 0005) both send this string, so their measurements in one custom router share
 * byte-identical prompts.
 */
export function deciderCliPrompt(benchCase: DeciderCase): string {
  return taskPrompt(benchCase);
}

// @cloudflare/containers returns these 500 bodies before it forwards the request to
// server.mjs: "Failed to start container" when starting the instance or its port checks
// fail, and the runtime's refusal to connect to an instance that is not running or has
// just exited. Disconnects and other proxy errors can follow a delivered request, so
// they stay ambiguous.
const CONTAINER_NOT_REACHED_BODY =
  /^(?:Failed to start container: |Error proxying request to container: The container (?:just exited|is not running, consider calling start\(\)))/;

export const CONTAINER_NOT_REACHED_PREFIX = 'container not reached: ';

export function isContainerNotReachedBody(body: string): boolean {
  return CONTAINER_NOT_REACHED_BODY.test(body);
}

export function isRetryableContainerAvailabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('container /run failed: http 503') ||
    normalized.includes('container /warmup failed: http 503') ||
    normalized.includes('no container instance available') ||
    normalized.includes('no container instance that can be provided') ||
    normalized.includes('max concurrent instance count') ||
    normalized.includes('maximum number of running container instances exceeded')
  );
}

/**
 * A paid case stopped by an explicit cancel (a payer pausing), whichever transport carried
 * it: a CLI subprocess in the container or a direct gateway probe in the runner object.
 * The runner has already stopped it and reported to the result callback: a call that
 * produced output delivers a terminal `cancelled` marker carrying that output, a call that
 * spawned but produced none delivers a `cancelled` marker without it, and a call cancelled
 * before it launched delivers `not_started`. Replaying the error would be a new paid
 * attempt nobody asked for, so callers must treat it as terminal, not as a retryable
 * container failure.
 *
 * `stop` is set when the Worker itself ended the case (pause, no payer, superseded): it is a
 * trusted discriminator, so a caller classifies the case from it and never from provider
 * text, stderr or prior cost.
 */
export class BenchmarkCaseCancelledError extends Error {
  constructor(
    message: string,
    readonly stop?: BenchmarkCaseStop,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'BenchmarkCaseCancelledError';
  }
}

/** Why a paid start was refused before it could run. */
export type PaidAdmissionRefusalReason = 'not_live' | 'ledger_unavailable';

/**
 * The paid generation is not live, or its admission could not be verified, so nothing was
 * started for it: no provider request and no CLI subprocess. A caller must report the case
 * as known not started and must not retry the user's paid start; a scheduler may defer the
 * lane with its normal backoff, but a new paid attempt needs a new user request.
 *
 * `not_live`: the canonical case run is no longer the running generation this paid start
 * claimed (paused, cancelled, settled, reused, or superseded by a newer claim).
 * `ledger_unavailable`: the admission check failed (D1 fault); admission fails closed.
 */
export class BenchmarkCaseNotStartedError extends Error {
  constructor(
    message: string,
    readonly reason: PaidAdmissionRefusalReason,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'BenchmarkCaseNotStartedError';
  }
}

export function isCatalogLoadFailureResult(
  result: Pick<CliRunResult, 'text' | 'stderrTail' | 'costUsd' | 'timedOut'>
): boolean {
  if (result.text.length > 0 || (result.costUsd ?? 0) !== 0 || result.timedOut) return false;
  const diagnostic = stripVTControlCharacters(result.stderrTail);
  return (
    /\bfailed to load (?:the )?(?:kilo )?model catalog\b/i.test(diagnostic) ||
    /\bno models are currently available\b/i.test(diagnostic)
  );
}

const THROTTLE_DIAGNOSTIC = /(?:\b429\b|rate.?limit|throttl)/i;
const UNAVAILABLE_DIAGNOSTIC =
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|HTTP 5\d\d)\b/i;

export function hasThrottleDiagnostic(result: Pick<CliRunResult, 'stderrTail'>): boolean {
  return THROTTLE_DIAGNOSTIC.test(stripVTControlCharacters(result.stderrTail));
}

/**
 * A throttle or a provider outage on an unbilled call. Either can also end a
 * multi-step run after partial assistant text: the run still ends on that error
 * with no billed answer, so it is a transient provider failure, not a model failure.
 */
export function isUnbilledTransientProviderResult(
  result: Pick<
    CliRunResult,
    'text' | 'stderrTail' | 'costUsd' | 'exitCode' | 'lastEventTypes' | 'timedOut'
  >
): boolean {
  if ((result.costUsd ?? 0) !== 0 || result.timedOut) return false;
  const diagnostic = stripVTControlCharacters(result.stderrTail);
  if (!THROTTLE_DIAGNOSTIC.test(diagnostic) && !UNAVAILABLE_DIAGNOSTIC.test(diagnostic)) {
    return false;
  }
  return (
    result.text.length === 0 || (result.exitCode !== 0 && result.lastEventTypes.at(-1) === 'error')
  );
}

/**
 * The CLI process died from a signal before it emitted any event: no model
 * call produced output, so the run says nothing about the model.
 */
export function isKilledBeforeEventsResult(
  result: Pick<CliRunResult, 'text' | 'exitCode' | 'eventCount' | 'timedOut'>
): boolean {
  return (
    result.exitCode === -1 &&
    !result.timedOut &&
    result.eventCount === 0 &&
    result.text.length === 0
  );
}

/**
 * The gateway rejected the requested model on one unbilled call. The same model has
 * answered other cases, so this is a transient resolution failure, not retirement.
 * The diagnostic names the model without its vendor prefix.
 */
export function isUnsupportedModelResult(
  result: Pick<CliRunResult, 'text' | 'stderrTail' | 'costUsd' | 'timedOut'>,
  requestedModel: string
): boolean {
  if (result.text.length > 0 || (result.costUsd ?? 0) !== 0 || result.timedOut) return false;
  const diagnostic = stripVTControlCharacters(result.stderrTail);
  const model = /(?:^|\n)\s*(?:Error:\s*)?Unsupported model:?\s*(\S+)/i
    .exec(diagnostic)?.[1]
    ?.replace(/[.,;:!?)\]]+$/, '');
  const bare = requestedModel.slice(requestedModel.lastIndexOf('/') + 1);
  return model === requestedModel || model === `kilo/${requestedModel}` || model === bare;
}

export function isExactModelUnavailableResult(
  result: Pick<CliRunResult, 'text' | 'stderrTail' | 'unavailableModelId' | 'costUsd' | 'timedOut'>,
  requestedModel: string
): boolean {
  if (result.text.length > 0 || (result.costUsd ?? 0) !== 0 || result.timedOut) return false;
  if (isCatalogLoadFailureResult(result)) return false;
  if (
    result.unavailableModelId === requestedModel ||
    result.unavailableModelId === `kilo/${requestedModel}`
  ) {
    return true;
  }
  const diagnostic = stripVTControlCharacters(result.stderrTail);
  const model = /(?:^|\n)\s*(?:Error:\s*)?Model not found:\s*(\S+?)(?:\.(?=\s|$)|(?=\s|$))/i.exec(
    diagnostic
  )?.[1];
  return model === requestedModel || model === `kilo/${requestedModel}`;
}

export type ContainerRunResponse = {
  exitCode: number;
  durationMs: number;
  stdoutLines: string[];
  stderrTail: string;
  timedOut?: boolean;
  /** Trusted Worker stop carried by the proxy; never derived from output or stderr. */
  stop?: BenchmarkCaseStop;
};

type ContainerRunRequest = {
  model: string;
  benchCase: DeciderCase;
  kiloToken: string;
  kiloApiUrl: string;
  orgId?: string | null;
  variant?: string | null;
  inferenceProxy?: CaseInferenceProxy;
  resultCallback?: {
    url: string;
    execution: PaidLaunchExecutionKey;
  };
};

/**
 * The case-scoped inference transport handed to the runner container.
 *
 * The container's local reverse proxy is the CLI's whole API origin, so the CLI holds no
 * payer credential. Inference requests go to `url` + the gateway api with the capability
 * authorization and the invocation header; the worker resolves both to this exact paid
 * generation and its per-case cap. The capability is derived from the invocation tuple, so
 * its window comes from the signed `startedAt` (fixed 15 minutes) rather than an unsigned
 * field. Only exact catalog read routes are forwarded (with `catalog`), never an arbitrary
 * setup path, and nothing else is forwarded at all.
 */
export type CaseInferenceProxy = {
  /** Worker case-inference route base, e.g. `https://…/case-inference`. */
  url: string;
  /** `issueCaseInferenceCapability().authorization`, i.e. `Bearer <token>`. */
  authorization: string;
  /** `issueCaseInferenceCapability().invocationHeader`: base64url JSON invocation. */
  invocation: string;
  /** The shared invocation header name; defaults to {@link BENCHMARK_CASE_HEADER}. */
  invocationHeader?: string;
  /** Platform-bot transport for the exact catalog read routes, never for inference. */
  catalog?: { url: string; authorization: string };
};

/**
 * The container `/run` body for one decider case. A case graded on its tool calls runs
 * isolated in its own workspace; every other case keeps the body, and so the environment,
 * its stored results were measured with.
 */
export function containerRunBody(request: ContainerRunRequest) {
  const { model, benchCase, kiloToken, kiloApiUrl } = request;
  const variant = request.variant ?? null;
  return {
    model,
    prompt: deciderCliPrompt(benchCase),
    kiloToken,
    kiloApiUrl,
    orgId: request.orgId ?? null,
    timeoutMs: DECIDER_CLI_TIMEOUT_MS,
    variant,
    // An ordinary case keeps the body it was measured with; the proxy field appears only
    // when the scheduler issued a case-scoped capability for this run.
    ...(request.inferenceProxy === undefined || request.inferenceProxy === null
      ? {}
      : {
          inferenceProxy: {
            ...request.inferenceProxy,
            invocationHeader: request.inferenceProxy.invocationHeader ?? BENCHMARK_CASE_HEADER,
          },
        }),
    resultCallback: request.resultCallback ?? null,
    ...(benchCase.requiredToolCalls !== undefined ? { isolated: true } : {}),
  };
}

/**
 * Run one decider case through the `kilo` CLI inside a Cloudflare Container.
 *
 * `instanceName` is the precomputed DO instance name; the caller owns the
 * keying so chunks for the same model/repetition share a stable instance.
 */
export async function runDeciderCaseViaCli(
  env: Env,
  params: ContainerRunRequest & {
    instanceName: string;
    /** @deprecated Prefer `variant`. Same value; kept for call-site compatibility. */
    reasoningEffort?: string | null;
  }
): Promise<CliRunResult> {
  const { instanceName, model } = params;
  const variant = params.variant !== undefined ? params.variant : (params.reasoningEffort ?? null);
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(instanceName));

  const startedAt = Date.now();
  const generation = encodePaidGenerationHeader(params.resultCallback?.execution);
  const response = await stub.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(generation === null ? {} : { [PAID_GENERATION_HEADER]: generation }),
      },
      body: JSON.stringify(containerRunBody({ ...params, variant })),
    })
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    const stop = trustedCaseStop(response);
    const refusal = parseRunRefusal(detail);
    if (refusal === 'cancelled') {
      throw new BenchmarkCaseCancelledError(
        `container /run cancelled: ${detail}`,
        stop ?? undefined
      );
    }
    if (refusal !== null) {
      throw new BenchmarkCaseNotStartedError(`container /run refused: ${detail}`, refusal);
    }
    throw new Error(`container /run failed: HTTP ${response.status} ${detail}`);
  }

  return parseContainerRunResponse(await response.json(), startedAt, model);
}

function parseRunRefusal(body: string): 'cancelled' | PaidAdmissionRefusalReason | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if ('cancelled' in parsed && parsed.cancelled === true) return 'cancelled';
  if ('started' in parsed && parsed.started === false && 'reason' in parsed) {
    const reason = parsed.reason;
    if (reason === 'not_live' || reason === 'ledger_unavailable') return reason;
  }
  return null;
}

export function parseContainerRunResponse(
  body: ContainerRunResponse,
  startedAt: number,
  requestedModel: string
): CliRunResult {
  const {
    text,
    costUsd,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    eventCount,
    lastEventTypes,
    tools,
  } = parseKiloRunEvents(body.stdoutLines ?? []);
  const providerThrottled = (body.stdoutLines ?? []).some(line => {
    try {
      const event: unknown = JSON.parse(line);
      return (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'error' &&
        THROTTLE_DIAGNOSTIC.test(line)
      );
    } catch {
      return false;
    }
  });
  let unavailableModelId: string | undefined;
  if (
    text.length === 0 &&
    (costUsd ?? 0) === 0 &&
    !body.timedOut &&
    !isCatalogLoadFailureResult({
      text,
      costUsd,
      stderrTail: body.stderrTail ?? '',
      timedOut: body.timedOut ?? false,
    })
  ) {
    for (const line of body.stdoutLines ?? []) {
      try {
        const event: unknown = JSON.parse(line);
        if (
          typeof event !== 'object' ||
          event === null ||
          !('type' in event) ||
          event.type !== 'error'
        ) {
          continue;
        }
        if (!('error' in event) || typeof event.error !== 'object' || event.error === null)
          continue;
        const error = event.error;
        if (
          !('name' in error && error.name === 'ProviderModelNotFoundError') &&
          !('_tag' in error && error._tag === 'ProviderModelNotFoundError')
        )
          continue;
        const data =
          'data' in error && typeof error.data === 'object' && error.data !== null
            ? error.data
            : error;
        if (
          !('providerID' in data) ||
          typeof data.providerID !== 'string' ||
          !('modelID' in data) ||
          typeof data.modelID !== 'string'
        )
          continue;
        const model = `${data.providerID}/${data.modelID}`;
        if (model !== requestedModel && model !== `kilo/${requestedModel}`) continue;
        unavailableModelId = model;
        break;
      } catch {
        continue;
      }
    }
  }

  const result: CliRunResult = {
    text,
    costUsd,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    latencyMs: body.durationMs ?? Date.now() - startedAt,
    exitCode: body.exitCode,
    stderrTail: providerThrottled
      ? `${body.stderrTail ?? ''}\nHTTP 429 provider throttle`
      : (body.stderrTail ?? ''),
    eventCount,
    lastEventTypes,
    tools,
    timedOut: body.timedOut ?? false,
    ...(unavailableModelId ? { unavailableModelId } : {}),
    ...(isBenchmarkCaseStopReason(body.stop?.reason)
      ? { stop: { reason: body.stop.reason, status: body.stop.status } }
      : {}),
  };
  if (!result.unavailableModelId && isExactModelUnavailableResult(result, requestedModel)) {
    result.unavailableModelId = requestedModel;
  }
  return result;
}

// Ad-hoc CLI run for the /admin/debug-cli endpoint: returns raw (truncated)
// stdout lines alongside the parsed result so empty-output cases in prod can
// be diagnosed without redeploying.
export async function debugRunCli(
  env: Env,
  params: {
    model: string;
    prompt: string;
    kiloToken: string;
    kiloApiUrl: string;
    orgId?: string | null;
  }
): Promise<{
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  stdoutLines: string[];
  parsed: ReturnType<typeof parseKiloRunEvents>;
}> {
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(`debug:${params.model}`));
  const response = await stub.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        prompt: params.prompt,
        kiloToken: params.kiloToken,
        kiloApiUrl: params.kiloApiUrl,
        orgId: params.orgId ?? null,
        timeoutMs: DECIDER_CLI_TIMEOUT_MS,
      }),
    })
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /run failed: HTTP ${response.status} ${detail}`);
  }
  const body = (await response.json()) as ContainerRunResponse;
  const stdoutLines = (body.stdoutLines ?? []).slice(0, 80).map(l => l.slice(0, 600));
  return {
    exitCode: body.exitCode,
    durationMs: body.durationMs,
    stderrTail: body.stderrTail ?? '',
    stdoutLines,
    parsed: parseKiloRunEvents(body.stdoutLines ?? []),
  };
}

// Asks the container to run its one-time CLI warmup (sqlite migration etc.)
// before the case loop starts. Best-effort: callers ignore failures.
export async function warmUpCliContainer(
  env: Env,
  params: {
    instanceName: string;
    model: string;
    kiloToken: string;
    kiloApiUrl: string;
    orgId?: string | null;
  }
): Promise<void> {
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(params.instanceName));
  const response = await stub.fetch(
    new Request('http://container/warmup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        kiloToken: params.kiloToken,
        kiloApiUrl: params.kiloApiUrl,
        orgId: params.orgId ?? null,
      }),
    })
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /warmup failed: HTTP ${response.status} ${detail}`);
  }
}

export async function destroyDeciderCliContainer(
  env: Env,
  params: { instanceName: string }
): Promise<void> {
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(params.instanceName));
  const response = await stub.fetch(
    new Request('http://container/admin/destroy', {
      method: 'POST',
    })
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /admin/destroy failed: HTTP ${response.status} ${detail}`);
  }
}

const CANCEL_STATES = ['killed', 'dequeued', 'not_running'] as const;
export type CancelDeciderCaseState = (typeof CANCEL_STATES)[number];

export type CancelDeciderCaseResult = {
  /** True when this call stopped a subprocess or kept an accepted case from starting. */
  cancelled: boolean;
  /** `not_running` means nothing of that exact generation was active. */
  state: CancelDeciderCaseState;
};

function isCancelDeciderCaseState(value: unknown): value is CancelDeciderCaseState {
  return CANCEL_STATES.some(state => state === value);
}

function parseCancelDeciderCaseResponse(body: string): CancelDeciderCaseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('container /cancel returned a non-JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('container /cancel returned an unexpected body');
  }
  const cancelled = 'cancelled' in parsed ? parsed.cancelled : undefined;
  const state = 'state' in parsed ? parsed.state : undefined;
  if (typeof cancelled !== 'boolean' || !isCancelDeciderCaseState(state)) {
    throw new Error('container /cancel returned an unexpected body');
  }
  return { cancelled, state };
}

/**
 * Stops one paid case at its exact ledger generation (a payer pausing).
 *
 * Call it with the `instanceName` and `execution` handed to `runDeciderCaseViaCli` or
 * `runCancellableProbeCase`, so the runner object stops the call this paid generation
 * started: a CLI subprocess inside the container, or a direct gateway probe fetch that the
 * object itself is holding. `execution.attemptStartedAt` identifies the generation and is
 * required: a retry on the same model/repetition slot has a later start, so a stale cancel
 * reports `not_running` and never touches it. A cancel that arrives before the case is
 * accepted keeps it from starting at all.
 *
 * The stopped call fails with {@link BenchmarkCaseCancelledError}. Callers must treat that
 * error as terminal. A CLI run reports a terminal `cancelled` marker to its result callback
 * (with the output it produced, if any; never `not_started` once it spawned); a probe only
 * surfaces the typed error to its caller. Do not resubmit either as a paid attempt.
 *
 * Rejects when the runner object cannot be reached or answers unexpectedly.
 */
export async function cancelDeciderCase(
  env: Env,
  params: { instanceName: string; execution: PaidLaunchExecutionKey }
): Promise<CancelDeciderCaseResult> {
  const { instanceName, execution } = params;
  if (!Number.isInteger(execution.attemptStartedAt)) {
    throw new Error('cancelDeciderCase requires execution.attemptStartedAt');
  }
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(instanceName));
  const response = await stub.fetch(
    new Request('http://container/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ execution }),
    })
  );
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`container /cancel failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  return parseCancelDeciderCaseResponse(body);
}

/**
 * Header that carries the paid generation to the per-slot runner Durable Object. It lets
 * the object refuse a late `/run` without parsing (and buffering) the case prompt, and it
 * is the identity the object compares against its durable cancellation tombstones and the
 * canonical admission fence (claim token, start, and the canonical generation when sent).
 */
export const PAID_GENERATION_HEADER = 'x-benchmark-paid-generation';

const PaidCaseGenerationSchema = z.object({
  runId: z.string().min(1),
  // The claim token that admitted this paid start; the canonical row stores it as
  // `executor_token`, so a re-claim is a different generation, not the same one.
  token: z.string().min(1),
  model: z.string().min(1),
  variant: z.string(),
  rep: z.number().int(),
  caseId: z.string().min(1),
  attemptStartedAt: z.number().int().nonnegative(),
  // Present when the scheduler knows the canonical fence row it claimed; the admission
  // check then also compares this exact generation.
  canonicalGeneration: z.number().int().nonnegative().optional(),
  // The engine identity of the canonical case run, when the caller has it.
  engineIdentity: z.string().min(1).optional(),
});

/** The ledger generation of one paid call: the key of admission and of cancellation. */
export type PaidCaseGeneration = z.infer<typeof PaidCaseGenerationSchema>;

/** A paid execution identity, plus the canonical fence details when the caller has them. */
export type PaidCaseExecutionKey = PaidExecutionKey & {
  canonicalGeneration?: number;
  engineIdentity?: string;
};

/**
 * The execution envelope both launch helpers accept: the ledger generation, the canonical
 * fence details when the scheduler has them, and the retry bookkeeping the result callback
 * already carries.
 */
export type PaidLaunchExecutionKey = PaidCaseExecutionKey & {
  retried?: boolean;
  priorCostUsd?: number | null;
  priorUsage?: Omit<AttemptUsage, 'costUsd'> | null;
};

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function encodePaidGenerationHeader(execution: unknown): string | null {
  const parsed = PaidCaseGenerationSchema.safeParse(execution);
  return parsed.success ? base64UrlEncode(JSON.stringify(parsed.data)) : null;
}

export function decodePaidGenerationHeader(value: string | null): PaidCaseGeneration | null {
  if (value === null) return null;
  const text = base64UrlDecode(value);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const result = PaidCaseGenerationSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Canonical key for one generation, as the runner object holds it in memory and storage. */
export function paidGenerationKey(generation: PaidCaseGeneration): string {
  return JSON.stringify([
    generation.runId,
    generation.model,
    generation.variant,
    generation.rep,
    generation.caseId,
    generation.attemptStartedAt,
  ]);
}

export type PaidAdmissionCheck =
  | { live: true; generation: number }
  | { live: false; reason: PaidAdmissionRefusalReason };

/**
 * Point admission check for one paid start, run immediately before its call launches.
 *
 * The runner checks the canonical `benchmark_case_runs` row the paid start claimed — not
 * `scheduler_executions`, which survives a pause or cancel so a late callback stays
 * attributable. One indexed lookup on `executor_run_id` (IX_benchmark_case_runs_executor)
 * must find a row with the same run, claim token and start, keyed by the same case, in
 * status `running`; when the caller knows the canonical generation (or the engine
 * identity), those are compared too. Anything else means this exact generation is no
 * longer executing, so nothing may start.
 *
 * A D1 fault fails closed: the caller reports known not started and does no provider work.
 * The scheduler's canonical start time (`now`, stored as `started_at` text) must equal the
 * `attemptStartedAt` this generation carries; the emitter and the claim therefore have to
 * use one clock reading.
 */
export async function checkPaidCaseAdmission(
  db: D1Database,
  generation: PaidCaseGeneration
): Promise<PaidAdmissionCheck> {
  const startedAt = new Date(generation.attemptStartedAt).toISOString();
  try {
    const row = await db
      .prepare(`SELECT generation FROM benchmark_case_runs
        WHERE executor_run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
          AND executor_token = ? AND started_at = ? AND status = 'running'
          AND (? IS NULL OR generation = ?)
          AND (? IS NULL OR engine_identity = ?)
        LIMIT 1`)
      .bind(
        generation.runId,
        generation.model,
        generation.variant,
        generation.rep,
        generation.caseId,
        generation.token,
        startedAt,
        generation.canonicalGeneration ?? null,
        generation.canonicalGeneration ?? null,
        generation.engineIdentity ?? null,
        generation.engineIdentity ?? null
      )
      .first<{ generation: number }>();
    return row === null
      ? { live: false, reason: 'not_live' }
      : { live: true, generation: row.generation };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_paid_admission_check_failed',
        runId: generation.runId,
        model: generation.model,
        rep: generation.rep,
        caseId: generation.caseId,
        attemptStartedAt: generation.attemptStartedAt,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return { live: false, reason: 'ledger_unavailable' };
  }
}

/** Header the runner object sets on its own probe answers; upstream headers never carry it. */
export const PROBE_RUNNER_HEADER = 'x-benchmark-runner';

/** The only case-inference api a probe may reach: the object builds the URL from this enum. */
export const PROBE_GATEWAY_ENDPOINTS = ['chat/completions', 'responses', 'messages'] as const;
export type ProbeGatewayEndpoint = (typeof PROBE_GATEWAY_ENDPOINTS)[number];

const PROBE_HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
export const PROBE_BODY_MAX_BYTES = 8 * 1024 * 1024;

function isProbeGatewayEndpoint(value: string): value is ProbeGatewayEndpoint {
  return PROBE_GATEWAY_ENDPOINTS.some(endpoint => endpoint === value);
}

function invalidProbeParam(message: string): Error {
  return new Error(`probe request rejected: ${message}`);
}

/**
 * Why a case-inference envelope may not be used, or null when it may. The container repeats
 * these checks; this keeps a malformed envelope from leaving the worker at all.
 */
export function caseInferenceProxyProblem(proxy: CaseInferenceProxy): string | null {
  if (typeof proxy.url !== 'string' || !/^https?:\/\//.test(proxy.url)) {
    return 'inference url must be an http(s) base';
  }
  if (typeof proxy.authorization !== 'string' || !/^Bearer \S+$/.test(proxy.authorization)) {
    return 'inference authorization must be a bearer token';
  }
  if (typeof proxy.invocation !== 'string' || !/^[A-Za-z0-9_-]+$/.test(proxy.invocation)) {
    return 'inference invocation must be base64url';
  }
  if (
    proxy.invocationHeader !== undefined &&
    (typeof proxy.invocationHeader !== 'string' || !PROBE_HEADER_NAME.test(proxy.invocationHeader))
  ) {
    return 'inference invocation header must be a lowercase token';
  }
  if (proxy.catalog !== undefined) {
    if (
      typeof proxy.catalog.url !== 'string' ||
      !/^https?:\/\//.test(proxy.catalog.url) ||
      typeof proxy.catalog.authorization !== 'string' ||
      !/^Bearer \S+$/.test(proxy.catalog.authorization)
    ) {
      return 'catalog transport must be an http(s) base with a bearer token';
    }
  }
  return null;
}

/**
 * Sends one direct-probe gateway request through the per-slot runner Durable Object.
 *
 * The object never contacts a provider host for a probe: it posts to the worker's
 * case-inference route with the case capability and the signed invocation, exactly like the
 * CLI proxy, so a probe is attributable to the same paid generation and cancellable from
 * another isolate. Only the request body and content type cross the boundary; the executor's
 * captured template headers never carry a credential into it.
 *
 * A cancelled generation throws {@link BenchmarkCaseCancelledError}; a generation that is
 * no longer live (or could not be verified) throws {@link BenchmarkCaseNotStartedError}
 * after the object refused to fetch. Both are terminal: no retry.
 */
export async function fetchProbeThroughRunner(
  env: Env,
  params: {
    instanceName: string;
    execution: PaidCaseExecutionKey;
    endpoint: ProbeGatewayEndpoint;
    inference: CaseInferenceProxy;
    body: string;
    timeoutMs?: number;
  }
): Promise<Response> {
  const { instanceName, execution, endpoint, inference } = params;
  if (!Number.isInteger(execution.attemptStartedAt)) {
    throw invalidProbeParam('execution.attemptStartedAt is required');
  }
  if (!isProbeGatewayEndpoint(endpoint)) {
    throw invalidProbeParam('endpoint is not a gateway endpoint');
  }
  if (typeof params.body !== 'string' || params.body.length > PROBE_BODY_MAX_BYTES) {
    throw invalidProbeParam('body is too large');
  }
  const inferenceProblem = caseInferenceProxyProblem(inference);
  if (inferenceProblem !== null) throw invalidProbeParam(inferenceProblem);

  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(instanceName));
  const response = await stub.fetch(
    new Request('http://container/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        execution,
        endpoint,
        inference: {
          ...inference,
          invocationHeader: inference.invocationHeader ?? BENCHMARK_CASE_HEADER,
        },
        body: params.body,
        timeoutMs: params.timeoutMs ?? DECIDER_CLI_TIMEOUT_MS,
      }),
    })
  );
  const runnerState = response.headers.get(PROBE_RUNNER_HEADER);
  if (runnerState === 'cancelled') {
    throw new BenchmarkCaseCancelledError(
      'container /probe cancelled',
      trustedCaseStop(response) ?? undefined
    );
  }
  if (runnerState === 'not_live' || runnerState === 'ledger_unavailable') {
    throw new BenchmarkCaseNotStartedError(`container /probe refused: ${runnerState}`, runnerState);
  }
  if (runnerState !== null) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /probe ${runnerState}: ${detail}`);
  }
  return response;
}
