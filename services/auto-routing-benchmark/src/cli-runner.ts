import { parseKiloRunEvents } from './kilo-events';
import type { DeciderCase } from './datasets/decider-cases';

export type CliRunResult = {
  text: string;
  costUsd: number | null;
  latencyMs: number;
  exitCode: number;
  stderrTail: string;
};

const DECIDER_CLI_TIMEOUT_MS = 180_000;

type ContainerRunResponse = {
  exitCode: number;
  durationMs: number;
  stdoutLines: string[];
  stderrTail: string;
};

/**
 * Run one decider case through the `kilo` CLI inside a Cloudflare Container.
 *
 * `instanceName` is the precomputed DO instance name (e.g.
 * `${runId}:${model}:${chunk}`); the caller owns the keying so chunks/models
 * map to stable instances. The CLI has no system-prompt flag, so we fold the
 * system prompt into the user prompt.
 */
export async function runDeciderCaseViaCli(
  env: Env,
  params: { instanceName: string; model: string; benchCase: DeciderCase; kiloToken: string }
): Promise<CliRunResult> {
  const { instanceName, model, benchCase, kiloToken } = params;
  const stub = env.BENCH_RUNNER.get(env.BENCH_RUNNER.idFromName(instanceName));
  const prompt = `${benchCase.systemPrompt}\n\n${benchCase.userPrompt}`;

  const startedAt = Date.now();
  const response = await stub.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, kiloToken, timeoutMs: DECIDER_CLI_TIMEOUT_MS }),
    })
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`container /run failed: HTTP ${response.status} ${detail}`);
  }

  const body = (await response.json()) as ContainerRunResponse;
  const { text, costUsd } = parseKiloRunEvents(body.stdoutLines ?? []);

  return {
    text,
    costUsd,
    latencyMs: body.durationMs ?? Date.now() - startedAt,
    exitCode: body.exitCode,
    stderrTail: body.stderrTail ?? '',
  };
}
