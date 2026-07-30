import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { db } from '@/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { CLOUD_AGENT_CONNECTION_ID, resolveActiveSessionStatus } from './active-sessions-router';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

let regularUser: User;

function mockWorkerSessions(sessions: Array<Record<string, unknown>>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ sessions }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

function mockWorkerFailure(): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('upstream failed', { status: 502 }));
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const PREFIX = `asr-cloud-${Date.now()}`;
let seq = 0;

function nextId(label: string): string {
  return `${PREFIX}-${label}-${seq++}`;
}

type SeedCloudArgs = {
  sessionId: string;
  cloudAgentSessionId: string;
  kiloUserId: string;
  organizationId?: string | null;
  parentSessionId?: string | null;
  status?: string | null;
  statusUpdatedAt?: string | null;
  title?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  lastActivityAt?: string | null;
  createdOnPlatform?: string;
  createdAt?: string;
  /** null = no run row; object = insert run */
  run?: {
    terminalAt: string | null;
    status?: 'queued' | 'accepted' | 'completed' | 'failed';
  } | null;
};

const seededCloudAgentIds: string[] = [];
const seededSessionIds: string[] = [];

async function seedCloudSession(args: SeedCloudArgs): Promise<void> {
  const createdAt = args.createdAt ?? new Date().toISOString();
  await db.insert(cloud_agent_sessions).values({
    cloud_agent_session_id: args.cloudAgentSessionId,
    kilo_session_id: args.sessionId,
    initial_message_id: `${args.cloudAgentSessionId}-init`,
    created_at: createdAt,
  });
  seededCloudAgentIds.push(args.cloudAgentSessionId);

  await db.insert(cli_sessions_v2).values({
    session_id: args.sessionId,
    kilo_user_id: args.kiloUserId,
    cloud_agent_session_id: args.cloudAgentSessionId,
    parent_session_id: args.parentSessionId ?? null,
    organization_id: args.organizationId === undefined ? null : args.organizationId,
    status: args.status ?? null,
    status_updated_at: args.statusUpdatedAt ?? null,
    title: args.title ?? null,
    git_url: args.gitUrl ?? null,
    git_branch: args.gitBranch ?? null,
    last_activity_at: args.lastActivityAt ?? null,
    created_on_platform: args.createdOnPlatform ?? 'cloud-agent-web',
    created_at: createdAt,
  });
  seededSessionIds.push(args.sessionId);

  if (args.run !== null && args.run !== undefined) {
    const queuedAt = createdAt;
    await db.insert(cloud_agent_session_runs).values({
      cloud_agent_session_id: args.cloudAgentSessionId,
      message_id: `${args.cloudAgentSessionId}-msg`,
      status: args.run.status ?? (args.run.terminalAt ? 'completed' : 'accepted'),
      queued_at: queuedAt,
      terminal_at: args.run.terminalAt,
    });
  }
}

async function cleanupSeeds(): Promise<void> {
  if (seededSessionIds.length > 0) {
    await db
      .delete(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.session_id, [...seededSessionIds]));
    seededSessionIds.length = 0;
  }
  if (seededCloudAgentIds.length > 0) {
    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, [...seededCloudAgentIds]));
    seededCloudAgentIds.length = 0;
  }
}

describe('active-sessions-router.list cloud merge', () => {
  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'active-sessions-cloud-merge@example.com',
      google_user_name: 'Active Sessions Cloud Merge',
      is_admin: false,
    });
  });

  let fetchSpy: jest.SpyInstance;

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await cleanupSeeds();
  });

  it('flag absent: live cloud rows in DB are not returned (regression guard)', async () => {
    const sessionId = nextId('flag-off');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([
      {
        id: 'ses_heartbeat_only',
        status: 'busy',
        title: 'cli',
        connectionId: 'conn-1',
      },
    ]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list();

    expect(result.sessions.map(s => s.id)).toEqual(['ses_heartbeat_only']);
    expect(result.sessions.every(s => s.connectionId !== CLOUD_AGENT_CONNECTION_ID)).toBe(true);
  });

  it('flag on + non-terminal run → cloud row included', async () => {
    const sessionId = nextId('running');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      title: 'Cloud running',
      gitUrl: 'https://github.com/kilo/cloud',
      gitBranch: 'feat',
      lastActivityAt: '2026-07-15 12:00:00+00',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions).toHaveLength(1);
    const row = result.sessions[0]!;
    expect(row).toMatchObject({
      id: sessionId,
      status: 'busy',
      title: 'Cloud running',
      connectionId: CLOUD_AGENT_CONNECTION_ID,
      gitUrl: 'https://github.com/kilo/cloud',
      gitBranch: 'feat',
      lastActivityAt: '2026-07-15 12:00:00+00',
      organizationId: null,
      createdOnPlatform: 'cloud-agent-web',
    });
    expect(row).not.toHaveProperty('capabilities');
    expect(row).not.toHaveProperty('platform');
  });

  it('flag on + terminal run + fresh idle → included', async () => {
    const sessionId = nextId('warm-idle');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'idle',
      statusUpdatedAt: minutesAgoIso(5),
      title: 'Warm idle',
      run: { terminalAt: minutesAgoIso(5), status: 'completed' },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions.map(s => s.id)).toEqual([sessionId]);
    expect(result.sessions[0]?.status).toBe('idle');
  });

  it('flag on + terminal run + stale idle → excluded', async () => {
    const sessionId = nextId('stale-idle');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'idle',
      statusUpdatedAt: minutesAgoIso(20),
      run: { terminalAt: minutesAgoIso(20), status: 'completed' },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions).toEqual([]);
  });

  it('excludes child cloud rows (parent_session_id set)', async () => {
    const parentId = nextId('parent');
    const parentCas = nextId('cas-p');
    const childId = nextId('child');
    const childCas = nextId('cas-c');

    await seedCloudSession({
      sessionId: parentId,
      cloudAgentSessionId: parentCas,
      kiloUserId: regularUser.id,
      status: 'busy',
      run: { terminalAt: null },
    });
    await seedCloudSession({
      sessionId: childId,
      cloudAgentSessionId: childCas,
      kiloUserId: regularUser.id,
      parentSessionId: parentId,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions.map(s => s.id)).toEqual([parentId]);
  });

  it('dedupes: heartbeat id wins over cloud candidate (worker connectionId kept)', async () => {
    const sessionId = nextId('adopted');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'idle',
      title: 'db title',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([
      {
        id: sessionId,
        status: 'busy',
        title: 'wire title',
        connectionId: 'conn-real-cli',
        gitUrl: 'https://github.com/wire/repo',
        gitBranch: 'wire-branch',
      },
    ]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: sessionId,
      connectionId: 'conn-real-cli',
      status: 'busy',
      gitUrl: 'https://github.com/wire/repo',
      gitBranch: 'wire-branch',
    });
  });

  it('org contexts: personal / org / unfiltered see the right cloud rows', async () => {
    const organization = await createTestOrganization('Cloud Merge Org Context', regularUser.id, 0);
    const personalId = nextId('org-personal');
    const orgId = nextId('org-org');
    const personalCas = nextId('cas-p');
    const orgCas = nextId('cas-o');

    await seedCloudSession({
      sessionId: personalId,
      cloudAgentSessionId: personalCas,
      kiloUserId: regularUser.id,
      organizationId: null,
      status: 'busy',
      createdAt: minutesAgoIso(1),
      run: { terminalAt: null },
    });
    await seedCloudSession({
      sessionId: orgId,
      cloudAgentSessionId: orgCas,
      kiloUserId: regularUser.id,
      organizationId: organization.id,
      status: 'busy',
      createdAt: minutesAgoIso(2),
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);

    const personal = await caller.activeSessions.list({
      includeCloudAgentSessions: true,
      organizationId: null,
    });
    expect(personal.sessions.map(s => s.id)).toEqual([personalId]);
    expect(personal.sessions[0]).toHaveProperty('organizationId', null);

    const orgOnly = await caller.activeSessions.list({
      includeCloudAgentSessions: true,
      organizationId: organization.id,
    });
    expect(orgOnly.sessions.map(s => s.id)).toEqual([orgId]);
    expect(orgOnly.sessions[0]).toHaveProperty('organizationId', organization.id);

    const unfiltered = await caller.activeSessions.list({ includeCloudAgentSessions: true });
    expect(unfiltered.sessions.map(s => s.id).sort()).toEqual([personalId, orgId].sort());
  });

  it('NULL-org cloud row always emits organizationId: null', async () => {
    const sessionId = nextId('null-org');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      organizationId: null,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({
      includeCloudAgentSessions: true,
      organizationId: null,
    });

    expect(result.sessions).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(result.sessions[0], 'organizationId')).toBe(true);
    expect(result.sessions[0]?.organizationId).toBeNull();
  });

  it('heartbeat enrichment keeps wire git fields when DB differs; cloud takes DB git', async () => {
    const hbId = nextId('hb-git');
    const cloudId = nextId('cloud-git');
    const casId = nextId('cas');

    await db.insert(cli_sessions_v2).values({
      session_id: hbId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      git_url: 'https://github.com/db/different',
      git_branch: 'db-branch',
    });
    seededSessionIds.push(hbId);

    await seedCloudSession({
      sessionId: cloudId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      gitUrl: 'https://github.com/cloud/repo',
      gitBranch: 'cloud-branch',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([
      {
        id: hbId,
        status: 'busy',
        title: 'hb',
        connectionId: 'conn-hb',
        gitUrl: 'https://github.com/wire/repo',
        gitBranch: 'wire-branch',
      },
    ]);

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });
      const byId = new Map(result.sessions.map(s => [s.id, s]));

      expect(byId.get(hbId)).toMatchObject({
        gitUrl: 'https://github.com/wire/repo',
        gitBranch: 'wire-branch',
      });
      expect(byId.get(cloudId)).toMatchObject({
        gitUrl: 'https://github.com/cloud/repo',
        gitBranch: 'cloud-branch',
      });
    } finally {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, hbId));
      seededSessionIds.splice(seededSessionIds.indexOf(hbId), 1);
    }
  });

  it('lastActivityAt passthrough on both row kinds; key omitted when NULL', async () => {
    const hbId = nextId('hb-act');
    const cloudWith = nextId('cloud-act');
    const cloudNull = nextId('cloud-null-act');
    const casWith = nextId('cas-w');
    const casNull = nextId('cas-n');
    const activity = '2026-07-20 08:00:00+00';

    await db.insert(cli_sessions_v2).values({
      session_id: hbId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      last_activity_at: activity,
    });
    seededSessionIds.push(hbId);

    await seedCloudSession({
      sessionId: cloudWith,
      cloudAgentSessionId: casWith,
      kiloUserId: regularUser.id,
      status: 'busy',
      lastActivityAt: activity,
      createdAt: minutesAgoIso(1),
      run: { terminalAt: null },
    });
    await seedCloudSession({
      sessionId: cloudNull,
      cloudAgentSessionId: casNull,
      kiloUserId: regularUser.id,
      status: 'busy',
      lastActivityAt: null,
      createdAt: minutesAgoIso(2),
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([{ id: hbId, status: 'busy', title: 'hb', connectionId: 'c1' }]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });
    const byId = new Map(result.sessions.map(s => [s.id, s]));

    expect(byId.get(hbId)?.lastActivityAt).toBe(activity);
    expect(byId.get(cloudWith)?.lastActivityAt).toBe(activity);
    expect(byId.get(cloudNull)).not.toHaveProperty('lastActivityAt');
  });

  it('NULL title/status on cloud rows map to empty string', async () => {
    const sessionId = nextId('null-fields');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: null,
      title: null,
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions[0]).toMatchObject({ status: '', title: '' });
  });

  it('cloud rows are not run through resolveActiveSessionStatus', async () => {
    // Stored status is "question"; without a live wire status the cloud path
    // must emit the raw DB value, not the overlay helper's opinion.
    const sessionId = nextId('no-overlay');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'question',
      run: { terminalAt: null },
    });

    // Sanity: the overlay would keep "question" over a live "busy", but for
    // cloud there is no live input — we assert the raw stored value only.
    expect(resolveActiveSessionStatus('busy', 'question')).toBe('question');

    fetchSpy = mockWorkerSessions([]);
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions[0]?.status).toBe('question');
  });

  it('worker fetch failure + flag on → cloud rows still returned', async () => {
    const sessionId = nextId('worker-fail');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerFailure();
    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions.map(s => s.id)).toEqual([sessionId]);
  });

  it('flag on + no heartbeat ids → cloud-only response (no empty inArray)', async () => {
    const sessionId = nextId('cloud-only');
    const casId = nextId('cas');
    await seedCloudSession({
      sessionId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([]);
    const selectSpy = jest.spyOn(db, 'select');

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

      expect(result.sessions.map(s => s.id)).toEqual([sessionId]);
      // Exactly one select (cloud candidates) — enrichment skipped when ids empty.
      expect(selectSpy).toHaveBeenCalledTimes(1);
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('enrichment fails + cloud healthy → unfiltered still gets cloud rows', async () => {
    const hbId = nextId('hb-enrich-fail');
    const cloudId = nextId('cloud-ok');
    const casId = nextId('cas');

    await seedCloudSession({
      sessionId: cloudId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([{ id: hbId, status: 'busy', title: 'hb', connectionId: 'c1' }]);

    // First select = enrichment (inArray on heartbeat ids); fail it.
    // Second select = cloud candidates; pass through.
    const originalSelect = db.select.bind(db);
    let selectCount = 0;
    const selectSpy = jest.spyOn(db, 'select').mockImplementation((fields?: unknown) => {
      selectCount += 1;
      if (selectCount === 1) {
        throw new Error('synthetic enrichment failure');
      }
      return Reflect.apply(originalSelect, db, fields === undefined ? [] : [fields]);
    });

    try {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

      const ids = result.sessions.map(s => s.id).sort();
      expect(ids).toEqual([cloudId, hbId].sort());
      // Heartbeat unenriched (no organizationId enrichment path — passthrough).
      const hb = result.sessions.find(s => s.id === hbId)!;
      expect(hb.connectionId).toBe('c1');
      expect(hb).not.toHaveProperty('createdOnPlatform');
      const cloud = result.sessions.find(s => s.id === cloudId)!;
      expect(cloud.connectionId).toBe(CLOUD_AGENT_CONNECTION_ID);
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('cloud fails + enrichment healthy → unfiltered keeps heartbeat; filtered throws', async () => {
    const hbId = nextId('hb-ok');
    await db.insert(cli_sessions_v2).values({
      session_id: hbId,
      kilo_user_id: regularUser.id,
      created_on_platform: 'cli',
      title: 'enriched',
    });
    seededSessionIds.push(hbId);

    fetchSpy = mockWorkerSessions([
      { id: hbId, status: 'busy', title: 'wire', connectionId: 'c1' },
    ]);

    const originalSelect = db.select.bind(db);
    const caller = await createCallerForUser(regularUser.id);

    // Unfiltered: enrichment succeeds (1st select), cloud fails (2nd).
    let selectCount = 0;
    const unfilteredSpy = jest.spyOn(db, 'select').mockImplementation((fields?: unknown) => {
      selectCount += 1;
      if (selectCount === 2) {
        throw new Error('synthetic cloud query failure');
      }
      return Reflect.apply(originalSelect, db, fields === undefined ? [] : [fields]);
    });
    try {
      const unfiltered = await caller.activeSessions.list({ includeCloudAgentSessions: true });
      expect(unfiltered.sessions).toHaveLength(1);
      expect(unfiltered.sessions[0]).toMatchObject({
        id: hbId,
        title: 'enriched',
        connectionId: 'c1',
      });
    } finally {
      unfilteredSpy.mockRestore();
    }

    // Filtered personal: enrichment ok, cloud fails → TRPCError.
    selectCount = 0;
    const filteredSpy = jest.spyOn(db, 'select').mockImplementation((fields?: unknown) => {
      selectCount += 1;
      if (selectCount === 2) {
        throw new Error('synthetic cloud query failure filtered');
      }
      return Reflect.apply(originalSelect, db, fields === undefined ? [] : [fields]);
    });
    try {
      await expect(
        caller.activeSessions.list({
          includeCloudAgentSessions: true,
          organizationId: null,
        })
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to resolve the organization context for active sessions',
      });
    } finally {
      filteredSpy.mockRestore();
    }
  });

  it('appends cloud rows after heartbeat rows (no server re-sort)', async () => {
    const hbId = nextId('hb-order');
    const cloudId = nextId('cloud-order');
    const casId = nextId('cas');

    // Cloud created more recently than a typical heartbeat would imply —
    // still must appear after heartbeat rows.
    await seedCloudSession({
      sessionId: cloudId,
      cloudAgentSessionId: casId,
      kiloUserId: regularUser.id,
      status: 'busy',
      createdAt: new Date().toISOString(),
      run: { terminalAt: null },
    });

    fetchSpy = mockWorkerSessions([{ id: hbId, status: 'busy', title: 'hb', connectionId: 'c1' }]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.activeSessions.list({ includeCloudAgentSessions: true });

    expect(result.sessions.map(s => s.id)).toEqual([hbId, cloudId]);
  });
});
