import {
  environmentBuildEventsReplySchema,
  environmentBuildInputSchema,
  type EnvironmentBuildEvents,
  type EnvironmentBuildEventsReply,
  type EnvironmentBuildInput,
  type EnvironmentBuildResult,
} from '../../../src/shared/environment-build-protocol.js';

/**
 * The builder's side of the build-scoped control endpoint. Every call is short
 * and bounded; a transient failure retries with backoff, a refusal (the build
 * was superseded, canceled or deleted, or the credential is not this build's)
 * stops the builder instead of retrying.
 */

const CALL_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

/** The coordinator refused this builder; it must stop work rather than retry. */
export class BuilderRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Environment build endpoint refused the builder (${status})`);
    this.name = 'BuilderRefusedError';
  }
}

export type BuilderClient = {
  input(): Promise<EnvironmentBuildInput>;
  events(batch: EnvironmentBuildEvents): Promise<EnvironmentBuildEventsReply>;
  result(result: EnvironmentBuildResult): Promise<void>;
};

export type BuilderClientDeps = {
  baseUrl: string;
  credential: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per call, including the first. */
  attempts?: number;
};

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createBuilderClient(deps: BuilderClientDeps): BuilderClient {
  const send = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = deps.attempts ?? RETRY_BACKOFF_MS.length + 1;
  const base = deps.baseUrl.replace(/\/$/, '');

  async function call(path: string, init: RequestInit): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await send(`${base}/${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${deps.credential}`,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (response.ok) return response.status === 204 ? undefined : await response.json();
        if (!retryable(response.status)) throw new BuilderRefusedError(response.status);
        lastError = new Error(`Environment build endpoint returned ${response.status}`);
      } catch (error) {
        if (error instanceof BuilderRefusedError) throw error;
        lastError = error;
      }
      if (attempt < attempts) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 8_000);
    }
    throw lastError instanceof Error ? lastError : new Error('Environment build endpoint failed');
  }

  return {
    async input() {
      return environmentBuildInputSchema.parse(await call('input', { method: 'GET' }));
    },
    async events(batch) {
      return environmentBuildEventsReplySchema.parse(
        await call('events', { method: 'POST', body: JSON.stringify(batch) })
      );
    },
    async result(result) {
      await call('result', { method: 'POST', body: JSON.stringify(result) });
    },
  };
}
