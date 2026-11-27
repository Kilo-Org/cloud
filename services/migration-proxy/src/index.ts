import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  MAX_REQUEST_BYTES,
  RunRequestSchema,
  configInvalidResponse,
  createResponse,
  deniedResponse,
  identityRejectedResponse,
  invalidRequestResponse,
  notFoundResponse,
  unavailableResponse,
} from './api';
import { attestRun, type Attested } from './attest';
import { expectedRun, readConfig, type ProxyConfig } from './config';
import type { Env } from './env';

export { MigrationRunDO } from './dos/MigrationRunDO';

/**
 * The migration proxy Worker (contract §4): `POST /v1/runs` and `GET /v1/runs/{id}`, each
 * authenticated by a GitHub OIDC token with the proxy's own audience, which STS verifies.
 */

/** The outbound handler both container intercepts use: every HTTP(S) request is refused (§1). */
export class DenyOutbound extends WorkerEntrypoint {
  async fetch(): Promise<Response> {
    return new Response('outbound HTTP is refused', { status: 403 });
  }
}

const RUN_PATH =
  /^\/v1\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * The one Durable Object instance per environment, which is the single-run lock (§1). No other
 * name is ever addressed, so at most one container exists.
 */
function runObject(env: Env, config: ProxyConfig) {
  // workerd implements no jurisdictions, so only the local stack addresses the plain namespace.
  const namespace =
    config.environment === 'development'
      ? env.MIGRATION_RUN_DO
      : env.MIGRATION_RUN_DO.jurisdiction('eu');
  return namespace.getByName('runs');
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') ?? '');
  return match?.[1] ?? null;
}

/** The body as text, or the status that refuses it: at most 1 KB (§4). */
async function boundedBody(request: Request): Promise<string | 400 | 413> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) return 413;
  if (request.body === null) return 400;
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return 413;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** `run_denied`'s actor: the expected workload, else the attested repository, else unattested. */
function denialActor(config: ProxyConfig, attested: Attested | null): string {
  if (attested === null) return 'github:unattested';
  return attested.workload === expectedRun(config.environment).workload
    ? attested.workload
    : `github:${attested.github.repositoryId}`;
}

/** §5 steps 1-2 for either route; a refusal is recorded and answered. */
async function authenticate(
  request: Request,
  env: Env,
  config: ProxyConfig
): Promise<{ attested: Attested } | { response: Response }> {
  const token = bearer(request);
  const record = (reason: string, attested: Attested | null) =>
    runObject(env, config).recordDenial({
      reason,
      actor: denialActor(config, attested),
      githubRunId: attested?.github.runId ?? null,
    });
  if (token === null) {
    await record('identity_rejected', null);
    return { response: identityRejectedResponse() };
  }
  const outcome = await attestRun(env.STS, token, config);
  switch (outcome.kind) {
    case 'ok':
      return { attested: outcome.attested };
    case 'unavailable':
      return { response: unavailableResponse('sts_unavailable', outcome.retryAfterSeconds) };
    case 'identity_rejected':
      await record('identity_rejected', null);
      return { response: identityRejectedResponse() };
    case 'denied':
      await record(outcome.reason, outcome.attested);
      return { response: deniedResponse(outcome.reason) };
  }
}

async function postRun(request: Request, env: Env, config: ProxyConfig): Promise<Response> {
  const body = await boundedBody(request);
  if (body === 400 || body === 413) return invalidRequestResponse(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidRequestResponse(400);
  }
  const runRequest = RunRequestSchema.safeParse(parsed);
  if (!runRequest.success) return invalidRequestResponse(400);
  const auth = await authenticate(request, env, config);
  if ('response' in auth) return auth.response;
  return createResponse(
    await runObject(env, config).createRun({ attested: auth.attested, sha: runRequest.data.sha })
  );
}

async function getRun(request: Request, env: Env, config: ProxyConfig, id: string) {
  const auth = await authenticate(request, env, config);
  if ('response' in auth) return auth.response;
  const run = await runObject(env, config).getRun(id);
  return run === null ? notFoundResponse() : Response.json(run);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runMatch = RUN_PATH.exec(url.pathname);
    const isPost = request.method === 'POST' && url.pathname === '/v1/runs';
    const isGet = request.method === 'GET' && runMatch !== null;
    if (!isPost && !isGet) return notFoundResponse();
    const loaded = readConfig(env);
    if (!loaded.ok) {
      console.error('migration-proxy: config_invalid', loaded.problems.join('; '));
      return configInvalidResponse();
    }
    if (isPost) return await postRun(request, env, loaded.config);
    return await getRun(request, env, loaded.config, runMatch?.[1] ?? '');
  },

  /** Keeps the object's alarm set, so the sampled check runs while no run is active (§3). */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const loaded = readConfig(env);
    if (!loaded.ok) return;
    await runObject(env, loaded.config).wake();
  },
} satisfies ExportedHandler<Env>;
