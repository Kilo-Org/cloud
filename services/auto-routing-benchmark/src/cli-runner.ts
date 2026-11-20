import { stripVTControlCharacters } from 'node:util';
import type { PaidExecutionKey } from './scheduler';
import { parseKiloRunEvents, type ToolEvidence } from './kilo-events';
import type { DeciderCase } from './datasets/decider-cases';
import { materializeLongContext } from './datasets/long-context';

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
};

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

// Appended to every decider prompt: the agent harness tends to wrap answers
// in prose ("The output is: ..."), which strict mechanical checks reject.
// One uniform instruction across all candidate models keeps grading fair.
const FINAL_ANSWER_SUFFIX =
  '\n\nIMPORTANT: Your final message must contain ONLY the answer in the exact requested format - no explanations, no preamble, no extra words.';

function taskPrompt(benchCase: DeciderCase): string {
  const prompts = materializeLongContext(benchCase);
  return `${prompts.systemPrompt}\n\n${prompts.userPrompt}${FINAL_ANSWER_SUFFIX}`;
}

/**
 * The exact text `kilo run` sends to the model for a decider case: the container writes it
 * to the CLI's stdin, which the CLI uses verbatim. Long-context cases carry their generated
 * workspace snapshot, as the offline sweep and candidate screen send them. The CLI has no
 * system-prompt flag, so the system prompt is folded in. The platform container and client
 * evals (ADR 0005) both send this string, so their measurements in one custom router share
 * byte-identical prompts. A continuation case already carries the task in its seeded
 * session, so its run sends only the message that resumes that session.
 */
export function deciderCliPrompt(benchCase: DeciderCase): string {
  return benchCase.continuation ? benchCase.continuation.message : taskPrompt(benchCase);
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
};

// The default primary agent of the pinned CLI (@kilocode/cli 7.8.27).
const CLI_AGENT = 'code';
const CLI_VERSION = '7.8.27';
const SEED_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
// `kilo run` creates its headless sessions with these rules; an imported session needs them too.
const HEADLESS_RUN_PERMISSIONS = ['question', 'suggest', 'plan_enter', 'plan_exit'].map(
  permission => ({ permission, action: 'deny', pattern: '*' })
);

// CLI ids are `<prefix>_`, 12 hex digits of (milliseconds * 0x1000 + counter), then 14 base62
// characters, and the CLI orders a session's messages and parts by id. Ticks in the first
// seconds of the epoch sort the seeded history before everything the resumed run creates; the
// run key keeps ids unique in the container's shared CLI database.
function seedId(prefix: 'ses' | 'msg' | 'prt', tick: number, runKey: string): string {
  return `${prefix}_${(tick * 0x1000).toString(16).padStart(12, '0')}${runKey}`;
}

type SeedPart = { id: string; sessionID: string; messageID: string } & (
  | { type: 'text'; text: string; time?: { start: number; end: number } }
  | { type: 'step-start' }
  | {
      type: 'tool';
      callID: string;
      tool: 'bash';
      state: {
        status: 'completed';
        input: { command: string; description: string };
        output: string;
        title: string;
        metadata: { output: string; description: string; truncated: false };
        time: { start: number; end: number };
      };
    }
  | {
      type: 'step-finish';
      reason: 'tool-calls';
      cost: number;
      tokens: typeof SEED_TOKENS;
    }
);

/**
 * The workspace files and the `kilo export` document of a continuation case's session in
 * progress: the task's user message, then one assistant message per step that already ran.
 * The container imports the session in the case workspace and resumes it with
 * {@link deciderCliPrompt}. Null for an ordinary case.
 */
export function continuationSeed(
  benchCase: DeciderCase,
  model: string,
  variant: string | null,
  runKey: string
) {
  const { continuation } = benchCase;
  if (!continuation) return null;
  let tick = 0;
  const next = (prefix: 'msg' | 'prt') => {
    tick += 1;
    return { id: seedId(prefix, tick, runKey), time: tick };
  };
  const sessionID = seedId('ses', 0, runKey);
  const variantField = variant ? { variant } : {};
  const user = next('msg');
  const messages: { info: Record<string, unknown>; parts: SeedPart[] }[] = [
    {
      info: {
        id: user.id,
        sessionID,
        role: 'user',
        time: { created: user.time },
        agent: CLI_AGENT,
        model: { providerID: 'kilo', modelID: model, ...variantField },
      },
      parts: [
        {
          id: next('prt').id,
          sessionID,
          messageID: user.id,
          type: 'text',
          text: taskPrompt(benchCase),
        },
      ],
    },
  ];
  continuation.steps.forEach((step, stepIndex) => {
    const message = next('msg');
    const ids = () => ({ id: next('prt').id, sessionID, messageID: message.id });
    const parts: SeedPart[] = [{ ...ids(), type: 'step-start' }];
    if (step.text !== undefined) {
      parts.push({
        ...ids(),
        type: 'text',
        text: step.text,
        time: { start: message.time, end: message.time },
      });
    }
    step.calls.forEach((call, callIndex) => {
      parts.push({
        ...ids(),
        type: 'tool',
        callID: `call_seed_${stepIndex}_${callIndex}`,
        tool: call.tool,
        state: {
          status: 'completed',
          input: { command: call.command, description: call.description },
          output: call.output,
          title: call.description,
          metadata: { output: call.output, description: call.description, truncated: false },
          time: { start: message.time, end: message.time },
        },
      });
    });
    parts.push({
      ...ids(),
      type: 'step-finish',
      reason: 'tool-calls',
      cost: 0,
      tokens: SEED_TOKENS,
    });
    messages.push({
      info: {
        id: message.id,
        sessionID,
        role: 'assistant',
        time: { created: message.time, completed: message.time },
        parentID: user.id,
        modelID: model,
        providerID: 'kilo',
        mode: CLI_AGENT,
        agent: CLI_AGENT,
        path: { cwd: '.', root: '.' },
        cost: 0,
        tokens: SEED_TOKENS,
        finish: 'tool-calls',
        ...variantField,
      },
      parts,
    });
  });
  return {
    files: continuation.files,
    session: {
      info: {
        id: sessionID,
        slug: 'benchmark-continuation',
        title: 'Benchmark continuation',
        version: CLI_VERSION,
        time: { created: tick, updated: tick },
        permission: HEADLESS_RUN_PERMISSIONS,
      },
      messages,
    },
  };
}

type ContainerRunRequest = {
  model: string;
  benchCase: DeciderCase;
  kiloToken: string;
  kiloApiUrl: string;
  orgId?: string | null;
  variant?: string | null;
  resultCallback?: {
    url: string;
    execution: PaidExecutionKey & {
      retried?: boolean;
      priorCostUsd?: number | null;
      priorUsage?: Omit<AttemptUsage, 'costUsd'> | null;
    };
  };
};

/**
 * The container `/run` body for one decider case. A case graded on its tool calls runs
 * isolated in its own workspace, and a continuation case also carries its `seed`; every other
 * case keeps the body, and so the environment, its stored results were measured with.
 */
export function containerRunBody(request: ContainerRunRequest) {
  const { model, benchCase, kiloToken, kiloApiUrl } = request;
  const variant = request.variant ?? null;
  const runKey = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  const seed = continuationSeed(benchCase, model, variant, runKey);
  return {
    model,
    prompt: deciderCliPrompt(benchCase),
    kiloToken,
    kiloApiUrl,
    orgId: request.orgId ?? null,
    timeoutMs: DECIDER_CLI_TIMEOUT_MS,
    variant,
    resultCallback: request.resultCallback ?? null,
    ...(benchCase.requiredToolCalls !== undefined ? { isolated: true } : {}),
    ...(seed ? { seed } : {}),
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
  const response = await stub.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(containerRunBody({ ...params, variant })),
    })
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /run failed: HTTP ${response.status} ${detail}`);
  }

  return parseContainerRunResponse(await response.json(), startedAt, model);
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
