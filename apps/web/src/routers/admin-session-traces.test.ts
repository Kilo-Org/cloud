const mockGetBlobContent = jest.fn();
const mockFetchSessionSnapshot = jest.fn();

jest.mock('@/lib/r2/cli-sessions', () => ({
  getBlobContent: (...args: unknown[]) => mockGetBlobContent(...args),
}));

jest.mock('@/lib/session-ingest-client', () => ({
  fetchSessionSnapshot: (...args: unknown[]) => mockFetchSessionSnapshot(...args),
}));

import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import {
  getSessionContainerMetrics,
  getSessionContainerMetricsForInfo,
} from '@/routers/admin/session-container-telemetry';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cliSessions,
  cli_sessions_v2,
  cloud_agent_sessions,
  cloud_billing_sku,
  container_usage_interval,
} from '@kilocode/db/schema';

async function insertAdmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({ is_admin: true, ...overrides });
}

describe('admin.sessionTraces authorization', () => {
  beforeEach(() => {
    mockGetBlobContent.mockReset();
    mockFetchSessionSnapshot.mockReset();
  });

  test.each([
    [
      'resolveCloudAgentSession',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.resolveCloudAgentSession({
          cloud_agent_session_id: 'agent_not_authorized',
        }),
    ],
    [
      'get',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.get({ session_id: crypto.randomUUID() }),
    ],
    [
      'getMessages',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getMessages({ session_id: crypto.randomUUID() }),
    ],
    [
      'getContainerInfo',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getContainerInfo({ session_id: crypto.randomUUID() }),
    ],
    [
      'getContainerMetrics',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getContainerMetrics({ session_id: crypto.randomUUID() }),
    ],
    [
      'getApiConversationHistory',
      (caller: Awaited<ReturnType<typeof createCallerForUser>>) =>
        caller.admin.sessionTraces.getApiConversationHistory({ session_id: crypto.randomUUID() }),
    ],
  ] as const)(
    '%s rejects non-admin, ordinary-admin, and superadmin-only callers',
    async (_, call) => {
      const nonAdmin = await insertTestUser();
      const ordinaryAdmin = await insertAdmin();
      const superadmin = await insertAdmin({ is_super_admin: true });

      await expect(call(await createCallerForUser(nonAdmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Admin access required',
      });
      await expect(call(await createCallerForUser(ordinaryAdmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Session viewing access required',
      });
      await expect(call(await createCallerForUser(superadmin.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Session viewing access required',
      });
      expect(mockGetBlobContent).not.toHaveBeenCalled();
      expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
    }
  );

  test('rejects valid sensitive resource IDs before external reads', async () => {
    const owner = await insertTestUser();
    const ordinaryAdmin = await insertAdmin();
    const [v1] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: owner.id,
        title: 'Unauthorized support trace',
        ui_messages_blob_url: 'sessions/unauthorized-messages.json',
      })
      .returning();
    if (!v1) throw new Error('Failed to create unauthorized v1 session');
    const v2Id = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({ session_id: v2Id, kilo_user_id: owner.id });

    const caller = await createCallerForUser(ordinaryAdmin.id);
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: v1.session_id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: v2Id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetBlobContent).not.toHaveBeenCalled();
    expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
  });

  test('a session viewer can resolve and read v1 metadata and blob-backed content', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
    const [session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: owner.id,
        title: 'Support trace',
        cloud_agent_session_id: cloudAgentSessionId,
        ui_messages_blob_url: 'sessions/messages.json',
        api_conversation_history_blob_url: 'sessions/history.json',
      })
      .returning();
    if (!session) throw new Error('Failed to create v1 session');

    const caller = await createCallerForUser(viewer.id);
    mockGetBlobContent
      .mockResolvedValueOnce([{ type: 'user', text: 'hello' }])
      .mockResolvedValueOnce([{ role: 'user', content: 'hello' }]);
    await expect(
      caller.admin.sessionTraces.resolveCloudAgentSession({
        cloud_agent_session_id: cloudAgentSessionId,
      })
    ).resolves.toEqual({ session_id: session.session_id });
    await expect(
      caller.admin.sessionTraces.get({ session_id: session.session_id })
    ).resolves.toMatchObject({ session_id: session.session_id, user: { id: owner.id } });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: session.session_id })
    ).resolves.toEqual({ messages: [{ type: 'user', text: 'hello' }], format: 'v1' });
    await expect(
      caller.admin.sessionTraces.getApiConversationHistory({ session_id: session.session_id })
    ).resolves.toEqual({ history: [{ role: 'user', content: 'hello' }] });
    expect(mockGetBlobContent).toHaveBeenNthCalledWith(1, 'sessions/messages.json');
    expect(mockGetBlobContent).toHaveBeenNthCalledWith(2, 'sessions/history.json');
  });

  test('a session viewer can resolve and read v2 metadata and messages', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const sessionId = `ses_${crypto.randomUUID()}`;
    const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: owner.id,
      cloud_agent_session_id: cloudAgentSessionId,
    });

    const caller = await createCallerForUser(viewer.id);
    mockFetchSessionSnapshot.mockResolvedValue({
      info: { id: sessionId },
      messages: [{ info: { id: 'message-1', role: 'user' }, parts: [] }],
    });
    await expect(
      caller.admin.sessionTraces.resolveCloudAgentSession({
        cloud_agent_session_id: cloudAgentSessionId,
      })
    ).resolves.toEqual({ session_id: sessionId });
    await expect(caller.admin.sessionTraces.get({ session_id: sessionId })).resolves.toMatchObject({
      session_id: sessionId,
      user: { id: owner.id },
    });
    await expect(
      caller.admin.sessionTraces.getApiConversationHistory({ session_id: sessionId })
    ).resolves.toEqual({ history: null });
    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: sessionId })
    ).resolves.toEqual({
      messages: [{ info: { id: 'message-1', role: 'user' }, parts: [] }],
      format: 'v2',
    });
    expect(mockFetchSessionSnapshot).toHaveBeenCalledWith(sessionId, owner.id);
  });

  test('getMessages sorts v2 messages and parts by time-ordered ID like the cloud-agent-next UI', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const sessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: owner.id,
    });

    const caller = await createCallerForUser(viewer.id);
    // The session-ingest export streams in ingest order, which can differ from
    // conversation order (assistant turn ingested before its user prompt).
    mockFetchSessionSnapshot.mockResolvedValue({
      info: { id: sessionId },
      messages: [
        {
          info: { id: 'msg_000000000002b', role: 'assistant' },
          parts: [{ id: 'part_000000000002b' }, { id: 'part_000000000001a' }],
        },
        { info: { id: 'msg_000000000001a', role: 'user' }, parts: [] },
      ],
    });

    await expect(
      caller.admin.sessionTraces.getMessages({ session_id: sessionId })
    ).resolves.toEqual({
      messages: [
        { info: { id: 'msg_000000000001a', role: 'user' }, parts: [] },
        {
          info: { id: 'msg_000000000002b', role: 'assistant' },
          parts: [{ id: 'part_000000000001a' }, { id: 'part_000000000002b' }],
        },
      ],
      format: 'v2',
    });
  });

  test('a session viewer can read Cloud Agent container identity, SKU, and recorded capacity', async () => {
    const owner = await insertTestUser();
    const viewer = await insertAdmin({ can_view_sessions: true });
    const sessionId = `ses_${crypto.randomUUID()}`;
    const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
    const sandboxId = `ses-${'a'.repeat(48)}`;
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: owner.id,
      cloud_agent_session_id: cloudAgentSessionId,
      created_at: '2026-07-31T08:43:36.040Z',
      updated_at: '2026-07-31T08:55:07.000Z',
    });
    await db.insert(cloud_agent_sessions).values({
      cloud_agent_session_id: cloudAgentSessionId,
      kilo_session_id: sessionId,
      initial_message_id: `msg_${crypto.randomUUID()}`,
      sandbox_id: sandboxId,
      created_at: '2026-07-31T08:43:36.040Z',
    });
    await db.insert(cloud_billing_sku).values({
      id: 'cloud-agent-small-test',
      name: 'Cloud Agent Small',
      unit: 'second',
      rate_cents_per_unit: '0.001',
    });
    await db.insert(container_usage_interval).values({
      id: `cloud-agent-next-sandbox-small-containment:${sandboxId}:1`,
      service: 'cloud-agent-next-sandbox-small-containment',
      instance_id: sandboxId,
      start_epoch_ms: 1,
      cloud_billing_sku_id: 'cloud-agent-small-test',
      context_fingerprint: 'b'.repeat(64),
      subject_type: 'user',
      subject_id: owner.id,
      actor_type: 'user',
      actor_id: owner.id,
      session_id: cloudAgentSessionId,
      started_at: '2026-07-31T08:20:00.000Z',
      last_seen_at: '2026-07-31T09:30:00.000Z',
      metadata: {
        durable_object_id: 'durable-object-id',
        container_class: 'SandboxSmallContainment',
        vcpu: '2',
        memory_mib: '6144',
        disk_mb: '10000',
      },
    });

    const caller = await createCallerForUser(viewer.id);
    await expect(
      caller.admin.sessionTraces.getContainerInfo({ session_id: sessionId })
    ).resolves.toMatchObject({
      cloudAgentSessionId,
      sandboxId,
      scope: 'isolated',
      intervals: [
        {
          cloudflareInstanceId: 'durable-object-id',
          containerClass: 'SandboxSmallContainment',
          sku: { id: 'cloud-agent-small-test', name: 'Cloud Agent Small' },
          capacity: { vcpu: 2, memoryBytes: 6_442_450_944, diskBytes: 10_000_000_000 },
          capacitySource: 'recorded',
        },
      ],
    });

    let providerWindows: unknown;
    await expect(
      getSessionContainerMetrics(sessionId, async input => {
        providerWindows = input.windows;
        return { rows: [], partial: false, issues: [] };
      })
    ).resolves.toMatchObject({ available: true });
    expect(providerWindows).toEqual([
      {
        key: `cloud-agent-next-sandbox-small-containment:${sandboxId}:1`,
        instanceId: 'durable-object-id',
        start: '2026-07-31T08:33:36.040Z',
        end: '2026-07-31T09:05:07.000Z',
      },
    ]);

    const info = await caller.admin.sessionTraces.getContainerInfo({ session_id: sessionId });
    expect(info).not.toBeNull();
    if (!info) throw new Error('Expected container info');
    await expect(
      getSessionContainerMetricsForInfo({
        ...info,
        windowStartAt: '2026-07-31T10:00:00.000Z',
        windowEndAt: '2026-07-31T10:10:00.000Z',
      })
    ).resolves.toEqual({ available: false, reason: 'no_overlapping_intervals' });

    const childSessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: childSessionId,
      kilo_user_id: owner.id,
      cloud_agent_session_scope_id: cloudAgentSessionId,
      created_at: '2026-07-31T08:44:00.000Z',
      updated_at: '2026-07-31T08:50:00.000Z',
    });
    await expect(
      caller.admin.sessionTraces.getContainerInfo({ session_id: childSessionId })
    ).resolves.toMatchObject({ cloudAgentSessionId, sandboxId });
  });
});
