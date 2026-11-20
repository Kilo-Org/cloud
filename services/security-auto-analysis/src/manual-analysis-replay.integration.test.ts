import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'node:http';
import { createDrizzleClient, type WorkerDb } from '@kilocode/db/client';
import type * as ClientModule from '@kilocode/db/client';
import {
  kilocode_users,
  platform_integrations,
  security_agent_commands,
  security_analysis_owner_state,
  security_analysis_queue,
  security_audit_log,
  security_findings,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { ensureManualAnalysisQueueRow, getSecurityFindingById } from './db/queries.js';
import { consumeManualAnalysisBatch, type ManualAnalysisStartCommand } from './manual-analysis.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-manual-replay-${randomUUID()}`;

// The consumer builds its own pool per batch, so the pools it creates are
// collected here to close them at teardown instead of leaving sockets open.
const analysisPools: { end: () => Promise<void> }[] = [];

vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    getWorkerDb: (conn: string, options?: Parameters<typeof actual.getWorkerDb>[1]) => {
      const db = actual.getWorkerDb(conn, options);
      analysisPools.push(db.$client);
      return db;
    },
  };
});

let client: ReturnType<typeof createDrizzleClient>;
let platformIntegrationId: string;

type PeerRequest = { path: string; body: unknown };
const cloudAgentRequests: PeerRequest[] = [];
let admissionOutcome: 'unavailable' | 'admitted' | 'refused' = 'unavailable';

/**
 * Cloud Agent peer. `unavailable` answers the admission query the way a peer
 * without the query does (404), which the service classifies as undecidable;
 * `refused` answers it with a 403, which the service classifies as a permanent
 * refusal; `admitted` answers it and serves the start calls.
 */
async function cloudAgentFetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const body = request.method === 'POST' ? await request.json() : null;
  cloudAgentRequests.push({ path: pathname, body });

  if (pathname === '/trpc/getAnalysisCreditAdmission') {
    if (admissionOutcome === 'unavailable') {
      return new Response('missing query', { status: 404 });
    }
    if (admissionOutcome === 'refused') {
      return new Response('refused', { status: 403 });
    }
    return Response.json({ result: { data: { outcome: 'admitted' } } });
  }
  if (pathname === '/trpc/prepareSession') {
    return Response.json({
      result: { data: { cloudAgentSessionId: 'agent-session-1', kiloSessionId: 'ses-1' } },
    });
  }
  if (pathname === '/trpc/initiateFromKilocodeSessionV2') {
    return Response.json({ result: { data: { executionId: 'execution-1', status: 'started' } } });
  }
  if (pathname === '/trpc/interruptSession') {
    return Response.json({ result: { data: {} } });
  }
  return new Response('unexpected peer route', { status: 404 });
}

let backend: Server;
let backendUrl = '';
const triageRequests: { model: string }[] = [];

const TRIAGE_TOOL_ARGUMENTS = JSON.stringify({
  needsSandboxAnalysis: true,
  needsSandboxReasoning: 'Runtime dependency reachable from application code.',
  suggestedAction: 'analyze_codebase',
  confidence: 'high',
});

beforeAll(async () => {
  client = createDrizzleClient({ connectionString, ssl: false });
  await client.db.insert(kilocode_users).values({
    id: testUserId,
    google_user_email: `${testUserId}@example.com`,
    google_user_name: 'Security Manual Replay Test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${randomUUID()}`,
  });
  platformIntegrationId = randomUUID();
  await client.db.insert(platform_integrations).values({
    id: platformIntegrationId,
    owned_by_user_id: testUserId,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: `security-manual-replay-${randomUUID()}`,
    permissions: { vulnerability_alerts: 'read' },
    repositories: [{ id: 1, name: 'replay', full_name: 'kilo/replay', private: true }],
    integration_status: 'active',
    github_connection_role: 'workflow',
  });

  backend = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += String(chunk);
    });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { model?: string };
      triageRequests.push({ model: parsed.model ?? '' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    function: { name: 'submit_triage_result', arguments: TRIAGE_TOOL_ARGUMENTS },
                  },
                ],
              },
            },
          ],
        })
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  backend.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('Test backend did not bind');
  backendUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  cloudAgentRequests.length = 0;
  triageRequests.length = 0;
  admissionOutcome = 'unavailable';
});

afterEach(async () => {
  const findings = await client.db
    .select({ id: security_findings.id })
    .from(security_findings)
    .where(eq(security_findings.owned_by_user_id, testUserId));
  const findingIds = findings.map(row => row.id);
  if (findingIds.length > 0) {
    await client.db
      .delete(security_analysis_queue)
      .where(inArray(security_analysis_queue.finding_id, findingIds));
    await client.db
      .delete(security_audit_log)
      .where(inArray(security_audit_log.finding_id, findingIds));
    await client.db
      .delete(security_agent_commands)
      .where(inArray(security_agent_commands.finding_id, findingIds));
    await client.db.delete(security_findings).where(inArray(security_findings.id, findingIds));
  }
});

afterAll(async () => {
  await client.db
    .delete(security_analysis_owner_state)
    .where(eq(security_analysis_owner_state.owned_by_user_id, testUserId));
  await client.db
    .delete(platform_integrations)
    .where(eq(platform_integrations.id, platformIntegrationId));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
  await client.pool.end();
  const closed = Promise.withResolvers<void>();
  backend.close(() => closed.resolve());
  await closed.promise;
  await Promise.all(analysisPools.map(pool => pool.end()));
});

function analysisEnv(): CloudflareEnv {
  return {
    HYPERDRIVE: { connectionString },
    GIT_TOKEN_SERVICE: {
      getTokenForRepo: async () => ({
        success: true,
        token: 'github-token',
        installationId: 'installation-1',
        accountLogin: 'kilo',
        appType: 'standard',
      }),
    },
    NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
    INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
    CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
    CLOUD_AGENT_NEXT: { fetch: cloudAgentFetch },
    KILOCODE_BACKEND_BASE_URL: backendUrl,
    SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
    SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: 'https://security-analysis.test',
    ENVIRONMENT: 'development',
  } as unknown as CloudflareEnv;
}

async function insertFinding(params: {
  analysisStatus: string | null;
  sessionId?: string | null;
}): Promise<string> {
  const findingId = randomUUID();
  await client.db.insert(security_findings).values({
    id: findingId,
    owned_by_user_id: testUserId,
    platform_integration_id: platformIntegrationId,
    repo_full_name: 'kilo/replay',
    source: 'dependabot',
    source_id: `replay-${randomUUID()}`,
    severity: 'high',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    dependency_scope: 'runtime',
    title: 'Replay test finding',
    status: 'open',
    analysis_status: params.analysisStatus,
    session_id: params.sessionId ?? null,
  });
  return findingId;
}

async function insertCommand(params: {
  findingId: string;
  requestedModels?: ManualAnalysisStartCommand['requestedModels'];
  restartActive?: boolean;
  forceSandbox?: boolean;
}): Promise<ManualAnalysisStartCommand> {
  const command: ManualAnalysisStartCommand = {
    schemaVersion: 1,
    commandId: randomUUID(),
    findingId: params.findingId,
    owner: { userId: testUserId },
    actorUserId: testUserId,
    ...(params.requestedModels ? { requestedModels: params.requestedModels } : {}),
    ...(params.restartActive ? { restartActive: true } : {}),
    ...(params.forceSandbox ? { forceSandbox: true } : {}),
  };
  await client.db.insert(security_agent_commands).values({
    id: command.commandId,
    command_type: 'start_analysis',
    origin: 'manual',
    owned_by_user_id: testUserId,
    finding_id: params.findingId,
    status: 'accepted',
  });
  return command;
}

function queueMessage(command: ManualAnalysisStartCommand, attempts: number) {
  return { body: command, attempts, ack: vi.fn(), retry: vi.fn() };
}

async function deliver(command: ManualAnalysisStartCommand, attempts: number) {
  const message = queueMessage(command, attempts);
  await consumeManualAnalysisBatch({ messages: [message] } as never, analysisEnv() as never);
  return message;
}

async function readQueueRow(findingId: string) {
  const rows = await client.db
    .select({
      status: security_analysis_queue.queue_status,
      claimToken: security_analysis_queue.claim_token,
      claimedByJobId: security_analysis_queue.claimed_by_job_id,
      failureCode: security_analysis_queue.failure_code,
      attemptCount: security_analysis_queue.attempt_count,
    })
    .from(security_analysis_queue)
    .where(eq(security_analysis_queue.finding_id, findingId));
  return rows[0] ?? null;
}

async function readFinding(findingId: string) {
  const rows = await client.db
    .select({
      analysisStatus: security_findings.analysis_status,
      sessionId: security_findings.session_id,
    })
    .from(security_findings)
    .where(eq(security_findings.id, findingId));
  return rows[0] ?? null;
}

async function readCommand(commandId: string) {
  const rows = await client.db
    .select({
      status: security_agent_commands.status,
      resultCode: security_agent_commands.result_code,
    })
    .from(security_agent_commands)
    .where(eq(security_agent_commands.id, commandId));
  return rows[0] ?? null;
}

describe('manual analysis command replay', () => {
  it('replays the original command after an undecided admission read', async () => {
    const findingId = await insertFinding({ analysisStatus: null });
    const command = await insertCommand({
      findingId,
      requestedModels: {
        triageModel: 'request/triage-model',
        analysisModel: 'request/analysis-model',
      },
    });

    const firstDelivery = await deliver(command, 1);

    expect(firstDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(firstDelivery.ack).not.toHaveBeenCalled();
    expect(triageRequests).toHaveLength(0);
    expect(cloudAgentRequests.map(request => request.path)).toEqual([
      '/trpc/getAnalysisCreditAdmission',
    ]);
    // The row stays this command's own claim and the finding is not failed, so
    // the next delivery can report on the same attempt.
    expect(await readQueueRow(findingId)).toEqual({
      status: 'pending',
      claimToken: expect.any(String),
      claimedByJobId: `manual:${command.commandId}`,
      failureCode: null,
      attemptCount: 0,
    });
    expect(await readFinding(findingId)).toEqual({
      analysisStatus: 'pending',
      sessionId: null,
    });
    expect(await readCommand(command.commandId)).toEqual({ status: 'running', resultCode: null });

    admissionOutcome = 'admitted';
    cloudAgentRequests.length = 0;
    const secondDelivery = await deliver(command, 2);

    expect(secondDelivery.ack).toHaveBeenCalledTimes(1);
    expect(secondDelivery.retry).not.toHaveBeenCalled();
    // The parameters the command carries are the ones the replay uses.
    expect(triageRequests).toEqual([{ model: 'request/triage-model' }]);
    expect(
      cloudAgentRequests.find(request => request.path === '/trpc/prepareSession')?.body
    ).toMatchObject({ model: 'request/analysis-model' });
    expect(
      cloudAgentRequests.some(request => request.path === '/trpc/initiateFromKilocodeSessionV2')
    ).toBe(true);
    expect(await readCommand(command.commandId)).toEqual({
      status: 'succeeded',
      resultCode: 'ANALYSIS_LAUNCH_STARTED',
    });
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'running',
      claimedByJobId: `manual:${command.commandId}`,
      failureCode: null,
    });
    expect(await readFinding(findingId)).toEqual({
      analysisStatus: 'running',
      sessionId: 'agent-session-1',
    });
  });

  it('settles the row as failed when the last delivery still cannot decide', async () => {
    const findingId = await insertFinding({ analysisStatus: null });
    const command = await insertCommand({ findingId });

    const delivery = await deliver(command, 4);

    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'failed',
      failureCode: 'REQUEUE_TEMPORARY_PRECONDITION',
      attemptCount: 0,
    });
    expect(await readFinding(findingId)).toMatchObject({ analysisStatus: 'failed' });
    expect(await readCommand(command.commandId)).toEqual({
      status: 'failed',
      resultCode: 'REQUEUE_TEMPORARY_PRECONDITION',
    });
  });

  it('settles a refused admission with the declared code on the row and the command', async () => {
    const findingId = await insertFinding({ analysisStatus: null });
    const command = await insertCommand({ findingId });
    admissionOutcome = 'refused';

    const delivery = await deliver(command, 1);

    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(triageRequests).toHaveLength(0);
    expect(cloudAgentRequests.map(request => request.path)).toEqual([
      '/trpc/getAnalysisCreditAdmission',
    ]);
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'failed',
      failureCode: 'PERMISSION_DENIED_PERMANENT',
      attemptCount: 0,
    });
    expect(await readCommand(command.commandId)).toEqual({
      status: 'failed',
      resultCode: 'PERMISSION_DENIED_PERMANENT',
    });
    expect(await readFinding(findingId)).toEqual({
      analysisStatus: 'failed',
      sessionId: null,
    });
  });

  it('replays an active restart and re-takes the row it claimed', async () => {
    const findingId = await insertFinding({
      analysisStatus: 'running',
      sessionId: 'agent-old-session',
    });
    await client.db.insert(security_analysis_queue).values({
      finding_id: findingId,
      owned_by_user_id: testUserId,
      queue_status: 'running',
      severity_rank: 1,
      queued_at: new Date().toISOString(),
      claimed_at: new Date().toISOString(),
      claimed_by_job_id: 'scheduled-job',
      claim_token: 'scheduled-claim',
    });
    const command = await insertCommand({
      findingId,
      restartActive: true,
      forceSandbox: true,
      requestedModels: {
        triageModel: 'restart/triage-model',
        analysisModel: 'restart/analysis-model',
      },
    });

    const firstDelivery = await deliver(command, 1);

    expect(firstDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(firstDelivery.ack).not.toHaveBeenCalled();
    expect(triageRequests).toHaveLength(0);
    // The interrupted run is replaced once, on the delivery that prepares it.
    expect(cloudAgentRequests.map(request => request.path)).toEqual([
      '/trpc/interruptSession',
      '/trpc/getAnalysisCreditAdmission',
    ]);
    expect(await readQueueRow(findingId)).toEqual({
      status: 'pending',
      claimToken: `manual-restart:${command.commandId}`,
      claimedByJobId: `manual-restart:${command.commandId}`,
      failureCode: null,
      attemptCount: 0,
    });
    expect(await readFinding(findingId)).toEqual({
      analysisStatus: 'pending',
      sessionId: null,
    });

    admissionOutcome = 'admitted';
    cloudAgentRequests.length = 0;
    const secondDelivery = await deliver(command, 2);

    expect(secondDelivery.ack).toHaveBeenCalledTimes(1);
    expect(secondDelivery.retry).not.toHaveBeenCalled();
    expect(triageRequests).toEqual([{ model: 'restart/triage-model' }]);
    expect(
      cloudAgentRequests.find(request => request.path === '/trpc/prepareSession')?.body
    ).toMatchObject({ model: 'restart/analysis-model' });
    expect(await readCommand(command.commandId)).toEqual({
      status: 'succeeded',
      resultCode: 'ANALYSIS_RESTART_STARTED',
    });
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'running',
      claimToken: `manual-restart:${command.commandId}`,
      failureCode: null,
    });
  });
});

describe('manual analysis queue claim', () => {
  it('revives the pending row the same command already claimed and keeps another job out', async () => {
    const findingId = await insertFinding({ analysisStatus: 'pending' });
    const jobId = `manual:${randomUUID()}`;
    await client.db.insert(security_analysis_queue).values({
      finding_id: findingId,
      owned_by_user_id: testUserId,
      queue_status: 'pending',
      severity_rank: 1,
      queued_at: new Date().toISOString(),
      claimed_at: new Date().toISOString(),
      claimed_by_job_id: jobId,
      claim_token: 'first-claim',
    });
    const finding = await getSecurityFindingById(client.db as WorkerDb, findingId);
    if (!finding) throw new Error('Finding fixture was not inserted');

    await expect(
      ensureManualAnalysisQueueRow(client.db as WorkerDb, {
        finding,
        claimToken: 'second-claim',
        jobId,
      })
    ).resolves.toBe(true);
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'pending',
      claimToken: 'second-claim',
      claimedByJobId: jobId,
    });

    await expect(
      ensureManualAnalysisQueueRow(client.db as WorkerDb, {
        finding,
        claimToken: 'other-claim',
        jobId: `manual:${randomUUID()}`,
      })
    ).resolves.toBe(false);
    expect(await readQueueRow(findingId)).toMatchObject({
      status: 'pending',
      claimToken: 'second-claim',
      claimedByJobId: jobId,
    });
  });
});
