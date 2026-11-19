/**
 * Stand-in E2E for the no-acknowledgement branch in resumeFirstWorktreeCreate.
 *
 * Three same-key create attempts drive the reconcile ladder through the real
 * worker, real Durable Objects, real Postgres and the real session-ingest
 * service binding:
 *   1. session-ingest is down: the ingest RPC throws, the ledger row goes
 *      reconcile-pending (existing transport-failure behavior).
 *   2. session-ingest is replaced by a stub worker whose
 *      createSessionForCloudAgent resolves undefined (a worker without
 *      acknowledgement support): the resume must fail closed with the typed
 *      unavailable error, keep the row non-terminal, and remove the empty
 *      destination row best-effort.
 *   3. the real session-ingest is restored: the same-key retry completes and
 *      the session registers normally.
 *
 * Not wired into any suite; run manually against `pnpm dev:start cloud-agent`.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ensureTestUser,
  loadDevVars,
  loadRepoEnvFiles,
  mintApiToken,
} from './auth.js';

const SERVICE_PACKAGE_DIR = new URL('../../', import.meta.url).pathname;

function trpcUrl(workerUrl: string, procedure: string): string {
  return new URL(`/trpc/${procedure}`, workerUrl).toString();
}

async function trpcPrepare(
  workerUrl: string,
  bearer: string,
  internalApiSecret: string,
  input: Record<string, unknown>
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(trpcUrl(workerUrl, 'prepareSession'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'x-internal-api-key': internalApiSecret,
      'x-skip-balance-check': 'true',
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body, text };
}

function summarize(body: unknown): string {
  const text = JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function main(): Promise<void> {
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const workerUrl = process.env.WORKER_URL ?? 'http://localhost:8794';
  const email = `kilo-e2e-ack-${Date.now()}@cloud-agent-next-e2e.example.com`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email, { funded: true });
  const bearer = mintApiToken(user, devVars.NEXTAUTH_SECRET);
  const internalApiSecret = devVars.INTERNAL_API_SECRET as string;
  const operationKey = randomUUID();
  const prompt = `echo:ack-${randomUUID()}`;
  const input = {
    prompt,
    mode: 'code',
    model: 'kilo/fake-deterministic',
    gitUrl: 'https://github.com/octocat/Hello-World.git',
    shallow: true,
    createdOnPlatform: 'cloud-agent-web',
    clientProvenance: 'browser',
    autoInitiate: true,
    operationKey,
    autoCommit: false,
  };

  console.log(`attempt 1: ingest worker stopped (transport failure)`);
  const first = await trpcPrepare(workerUrl, bearer, internalApiSecret, input);
  console.log(`attempt 1 -> HTTP ${first.status}: ${summarize(first.body)}`);
  if (first.status < 500 || first.status >= 600) {
    throw new Error(`attempt 1: expected a 5xx transport failure, got ${first.status}`);
  }

  console.log(`attempt 2: stub ingest resolves undefined (no acknowledgement)`);
  const second = await trpcPrepare(workerUrl, bearer, internalApiSecret, input);
  console.log(`attempt 2 -> HTTP ${second.status}: ${summarize(second.body)}`);
  const secondEnvelope = JSON.stringify(second.body);
  if (second.status !== 503) {
    throw new Error(`attempt 2: expected HTTP 503, got ${second.status}`);
  }
  if (!secondEnvelope.includes('session_clone_unavailable')) {
    throw new Error(
      `attempt 2: expected the typed unavailable error, got ${summarize(second.body)}`
    );
  }

  console.log(`attempt 3: real ingest restored; same-key retry completes`);
  const third = await trpcPrepare(workerUrl, bearer, internalApiSecret, input);
  console.log(`attempt 3 -> HTTP ${third.status}: ${summarize(third.body)}`);
  if (third.status !== 200) {
    throw new Error(`attempt 3: expected HTTP 200, got ${third.status}: ${summarize(third.body)}`);
  }
  const thirdEnvelope = z
    .object({
      result: z.object({
        data: z.object({
          cloudAgentSessionId: z.string(),
          kiloSessionId: z.string(),
          replayed: z.boolean().optional(),
        }),
      }),
    })
    .parse(third.body);
  const thirdData = thirdEnvelope.result.data;
  if (!thirdData.cloudAgentSessionId || thirdData.replayed !== true) {
    throw new Error(`attempt 3: expected a replayed create, got ${summarize(third.body)}`);
  }

  console.log(
    `PASS operationKey=${operationKey} session=${String(thirdData.cloudAgentSessionId)} kilo=${String(thirdData.kiloSessionId)}`
  );
}

main().catch(error => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
