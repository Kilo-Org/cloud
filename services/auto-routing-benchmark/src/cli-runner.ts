import { stripVTControlCharacters } from 'node:util';
import type { PaidExecutionKey } from './scheduler';
import { parseKiloRunEvents } from './kilo-events';
import type { DeciderCase } from './datasets/decider-cases';
import { materializeLongContext } from './datasets/long-context';

export type CliRunResult = {
  text: string;
  costUsd: number | null;
  latencyMs: number;
  exitCode: number;
  stderrTail: string;
  eventCount: number;
  lastEventTypes: string[];
  timedOut: boolean;
  unavailableModelId?: string;
};

export const DECIDER_CLI_TIMEOUT_MS = 180_000;

// Appended to every decider prompt: the agent harness tends to wrap answers
// in prose ("The output is: ..."), which strict mechanical checks reject.
// One uniform instruction across all candidate models keeps grading fair.
const FINAL_ANSWER_SUFFIX =
  '\n\nIMPORTANT: Your final message must contain ONLY the answer in the exact requested format - no explanations, no preamble, no extra words.';

/**
 * The exact text `kilo run` sends to the model for a decider case: the container writes it
 * to the CLI's stdin, which the CLI uses verbatim. Long-context cases carry their generated
 * workspace snapshot, as the offline sweep and candidate screen send them. The CLI has no
 * system-prompt flag, so the system prompt is folded in. The platform container and client
 * evals (ADR 0005) both send this string, so their measurements in one custom router share
 * byte-identical prompts.
 */
export function deciderCliPrompt(benchCase: DeciderCase): string {
  const prompts = materializeLongContext(benchCase);
  return `${prompts.systemPrompt}\n\n${prompts.userPrompt}${FINAL_ANSWER_SUFFIX}`;
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

export function isExactModelUnavailableResult(
  result: Pick<CliRunResult, 'text' | 'stderrTail' | 'unavailableModelId' | 'costUsd' | 'timedOut'>,
  requestedModel: string
): boolean {
  if (result.text.length > 0 || (result.costUsd ?? 0) !== 0 || result.timedOut) return false;
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

/**
 * Run one decider case through the `kilo` CLI inside a Cloudflare Container.
 *
 * `instanceName` is the precomputed DO instance name; the caller owns the
 * keying so chunks for the same model/repetition share a stable instance.
 */
export async function runDeciderCaseViaCli(
  env: Env,
  params: {
    instanceName: string;
    model: string;
    benchCase: DeciderCase;
    kiloToken: string;
    kiloApiUrl: string;
    orgId?: string | null;
    /**
     * Canonical catalog variant passed as the container body's `variant`
     * field (unchanged body shape). Accepts the legacy `reasoningEffort`
     * alias so existing call sites keep working.
     */
    variant?: string | null;
    /** @deprecated Prefer `variant`. Same value; kept for call-site compatibility. */
    reasoningEffort?: string | null;
    /** Where the container posts the outcome if this request's connection is lost. */
    resultCallback?: { url: string; execution: PaidExecutionKey };
  }
): Promise<CliRunResult> {
  const { instanceName, model, benchCase, kiloToken, kiloApiUrl, orgId } = params;
  const variant = params.variant !== undefined ? params.variant : (params.reasoningEffort ?? null);
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(instanceName));
  const prompt = deciderCliPrompt(benchCase);

  const startedAt = Date.now();
  const response = await stub.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        kiloToken,
        kiloApiUrl,
        orgId: orgId ?? null,
        timeoutMs: DECIDER_CLI_TIMEOUT_MS,
        variant: variant ?? null,
        resultCallback: params.resultCallback ?? null,
      }),
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
  const { text, costUsd, eventCount, lastEventTypes } = parseKiloRunEvents(body.stdoutLines ?? []);
  const providerThrottled = (body.stdoutLines ?? []).some(line => {
    try {
      const event: unknown = JSON.parse(line);
      return (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'error' &&
        /(?:\b429\b|rate.?limit|throttl)/i.test(line)
      );
    } catch {
      return false;
    }
  });
  let unavailableModelId: string | undefined;
  if (text.length === 0 && (costUsd ?? 0) === 0 && !body.timedOut) {
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
    latencyMs: body.durationMs ?? Date.now() - startedAt,
    exitCode: body.exitCode,
    stderrTail: providerThrottled
      ? `${body.stderrTail ?? ''}\nHTTP 429 provider throttle`
      : (body.stderrTail ?? ''),
    eventCount,
    lastEventTypes,
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
