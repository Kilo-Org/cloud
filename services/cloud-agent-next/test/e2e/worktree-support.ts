import {
  and,
  cli_sessions_v2,
  computeDatabaseUrl,
  createDrizzleClient,
  eq,
  inArray,
} from '@kilocode/db';
import {
  fetchFakeScenarioStatus,
  messageIdFromEvent,
  openStream,
  waitForGateEngaged,
  type DriverConfig,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import {
  waitForControlPlaneKiloCompletion,
  type ControlPlaneKiloRuntime,
} from './sandbox-control.js';

export type WorktreeOwnershipRow = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  parentSessionId: string | null;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
  worktreeId: string | null;
};

export async function openConnectedStream(
  config: DriverConfig,
  sessionId: string,
  replay = true,
  onEvent?: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<StreamConnection> {
  const stream = openStream(
    config,
    sessionId,
    onEvent === undefined ? { replay, signal } : { replay, onEvent, signal }
  );
  const connected = await stream.waitFor(event => event.streamEventType === 'connected', 10_000);
  if (!connected) {
    stream.close();
    throw new Error(`Stream did not connect for ${sessionId}`);
  }
  return stream;
}

export async function readWorktreeOwnership(
  config: DriverConfig,
  kiloSessionIds: string[]
): Promise<WorktreeOwnershipRow[]> {
  const driver = createDrizzleClient({
    connectionString: process.env.DATABASE_URL ?? computeDatabaseUrl(),
    poolConfig: { application_name: 'cloud-agent-next-worktree-e2e', max: 1 },
  });
  try {
    return await driver.db
      .select({
        sessionId: cli_sessions_v2.session_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
        parentSessionId: cli_sessions_v2.parent_session_id,
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
        worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, config.user.id),
          inArray(cli_sessions_v2.session_id, kiloSessionIds)
        )
      );
  } finally {
    await driver.pool.end();
  }
}

export function requireWorktreeSessionIdentity(
  session: WorktreeSessionResult,
  label: string
): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(session.cloudAgentSessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity`);
  }
  if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session.kiloSessionId)) {
    throw new Error(`${label} did not receive a valid root ses_* identity`);
  }
}

export async function requireWorktreeGate(
  config: DriverConfig,
  tag: string,
  timeoutMs: number,
  stream?: StreamConnection,
  messageId?: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const firstEvent = stream?.events.length ?? 0;
  while (Date.now() < deadline) {
    const [engaged, status] = await Promise.all([
      waitForGateEngaged(config, tag, 200, 50),
      fetchFakeScenarioStatus(config.fakeLlmUrl, tag),
    ]);
    if (status.unsupportedToolSchema) {
      throw new Error(`unsupported real Kilo tool schema for fake directive ${tag}`);
    }
    if (engaged) return;
    // With a message id, fail fast on a failure this exact message already
    // received before the wait began. Without one, keep the window scoped to
    // this gate so a multi-turn caller never reads an earlier turn's failure
    // as this gate miss.
    const observed = messageId === undefined ? stream?.events.slice(firstEvent) : stream?.events;
    const failure = observed?.find(
      event =>
        ['error', 'interrupted', 'cloud.message.failed'].includes(event.streamEventType) &&
        (messageId === undefined || messageIdFromEvent(event) === messageId)
    );
    if (failure) {
      throw new Error(
        `fake directive ${tag} terminated as ${failure.streamEventType} before gating`
      );
    }
  }
  const status = await fetchFakeScenarioStatus(config.fakeLlmUrl, tag);
  if (status.requests > 0 && Object.values(status.toolCalls).every(count => count === 0)) {
    throw new Error(`required real Kilo tool schema was not advertised for fake directive ${tag}`);
  }
  throw new Error(
    `fake directive ${tag} did not engage within ${timeoutMs}ms; requests=${status.requests}; toolCalls=${JSON.stringify(status.toolCalls)}; toolResults=${JSON.stringify(status.toolResults)}`
  );
}

export async function waitForOwnedCompletion(
  runtime: ControlPlaneKiloRuntime,
  session: WorktreeSessionResult,
  messageId: string,
  marker: string,
  timeoutMs = 15_000
): Promise<void> {
  await waitForControlPlaneKiloCompletion(runtime, {
    kiloSessionId: session.kiloSessionId,
    messageId,
    expectedText: marker,
    timeoutMs,
  });
}
