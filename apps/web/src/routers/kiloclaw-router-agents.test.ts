/* eslint-disable drizzle/enforce-delete-with-where */
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

// Mock only the external worker boundary (per AGENTS.md: avoid mocks otherwise —
// real user/instance/subscription rows back these tests). KiloClawApiError is the
// real class so the router's `instanceof` checks and our constructed errors match.
const agentMocks = {
  listAgents: jest.fn(),
  getAgent: jest.fn(),
  createAgent: jest.fn(),
  updateAgent: jest.fn(),
  updateAgentDefaults: jest.fn(),
  deleteAgent: jest.fn(),
};

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const actual = jest.requireActual('@/lib/kiloclaw/kiloclaw-internal-client');
  return {
    KiloClawApiError: actual.KiloClawApiError,
    KiloClawInternalClient: jest.fn().mockImplementation(() => agentMocks),
  };
});

import { KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';

function apiError(status: number, code: string, error: string) {
  return new KiloClawApiError(status, JSON.stringify({ code, error }));
}

const AGENT_SUMMARY = {
  id: 'work',
  name: 'Work',
  configured: true,
  workspace: '/home/agents/work',
  agentDir: '/state/work',
  model: { primary: null, fallbacks: [], source: null },
  rawModel: null,
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
};
const DEFAULTS_SUMMARY = {
  model: null,
  settings: {
    thinkingDefault: null,
    verboseDefault: null,
    reasoningDefault: null,
    fastModeDefault: null,
  },
};
const LIST_RESPONSE = { etag: 'e1', defaults: DEFAULTS_SUMMARY, agents: [AGENT_SUMMARY] };

let personalUser: User;
let orgOwner: User;
let orgId: string;

beforeAll(async () => {
  personalUser = await insertTestUser({
    google_user_email: `agents-personal-${Date.now()}@example.com`,
  });
  const [personalInstance] = await db
    .insert(kiloclaw_instances)
    .values({ user_id: personalUser.id, sandbox_id: `agents-personal-${Date.now()}` })
    .returning({ id: kiloclaw_instances.id });
  const trialEnd = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await db.insert(kiloclaw_subscriptions).values({
    user_id: personalUser.id,
    instance_id: personalInstance.id,
    plan: 'trial' as const,
    status: 'trialing' as const,
    trial_started_at: new Date().toISOString(),
    trial_ends_at: trialEnd,
  });

  orgOwner = await insertTestUser({
    google_user_email: `agents-org-${Date.now()}@example.com`,
  });
  const org = await createTestOrganization('Agents Test Org', orgOwner.id, 1_000_000);
  orgId = org.id;
  await db.insert(kiloclaw_instances).values({
    user_id: orgOwner.id,
    organization_id: orgId,
    sandbox_id: `agents-org-${Date.now()}`,
  });
});

afterAll(async () => {
  try {
    await db
      .delete(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, personalUser.id));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.user_id, personalUser.id));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.user_id, orgOwner.id));
  } catch {
    // DB may already be torn down by the framework
  }
});

beforeEach(() => {
  for (const m of Object.values(agentMocks)) m.mockReset();
});

describe('kiloclaw agent procedures (personal namespace)', () => {
  it('listAgents delegates to the client and returns the fleet', async () => {
    agentMocks.listAgents.mockResolvedValue(LIST_RESPONSE);
    const caller = await createCallerForUser(personalUser.id);

    const result = await caller.kiloclaw.listAgents();

    expect(result).toEqual(LIST_RESPONSE);
    expect(agentMocks.listAgents).toHaveBeenCalledTimes(1);
    expect(agentMocks.listAgents.mock.calls[0][0]).toBe(personalUser.id);
  });

  it('createAgent forwards the validated agent body', async () => {
    agentMocks.createAgent.mockResolvedValue({
      ok: true,
      etag: 'e1',
      agent: AGENT_SUMMARY,
      created: { agentId: 'work', name: 'Work', workspace: '/home/agents/work', agentDir: '/s' },
    });
    const caller = await createCallerForUser(personalUser.id);

    await caller.kiloclaw.createAgent({ name: 'Work', workspace: '/home/agents/work' });

    expect(agentMocks.createAgent).toHaveBeenCalledTimes(1);
    expect(agentMocks.createAgent.mock.calls[0][0]).toBe(personalUser.id);
    expect(agentMocks.createAgent.mock.calls[0][1]).toEqual({
      name: 'Work',
      workspace: '/home/agents/work',
    });
  });

  it('updateAgent forwards agentId and patch', async () => {
    agentMocks.updateAgent.mockResolvedValue({ ok: true, etag: 'e2', agent: AGENT_SUMMARY });
    const caller = await createCallerForUser(personalUser.id);

    await caller.kiloclaw.updateAgent({
      agentId: 'work',
      patch: { etag: 'e1', set: { thinkingDefault: 'high' } },
    });

    expect(agentMocks.updateAgent.mock.calls[0][1]).toBe('work');
    expect(agentMocks.updateAgent.mock.calls[0][2]).toEqual({
      etag: 'e1',
      set: { thinkingDefault: 'high' },
      unset: [],
    });
  });

  it('deleteAgent forwards the agentId', async () => {
    agentMocks.deleteAgent.mockResolvedValue({
      ok: true,
      filesystemDisposition: 'unverified',
      agentId: 'work',
      workspace: '/w',
      agentDir: '/s',
      sessionsDir: '/s/sessions',
      removedBindings: 0,
      removedAllow: 0,
    });
    const caller = await createCallerForUser(personalUser.id);

    await caller.kiloclaw.deleteAgent({ agentId: 'work' });

    expect(agentMocks.deleteAgent.mock.calls[0][1]).toBe('work');
  });

  it('rejects invalid input before calling the client (non-absolute workspace)', async () => {
    const caller = await createCallerForUser(personalUser.id);

    await expect(
      caller.kiloclaw.createAgent({ name: 'Work', workspace: 'relative/path' })
    ).rejects.toThrow();
    expect(agentMocks.createAgent).not.toHaveBeenCalled();
  });

  // ── error mapping ──────────────────────────────────────────────────
  it('maps 404 agent_not_found to NOT_FOUND', async () => {
    agentMocks.getAgent.mockRejectedValue(apiError(404, 'agent_not_found', 'Agent not found'));
    const caller = await createCallerForUser(personalUser.id);

    await expect(caller.kiloclaw.getAgent({ agentId: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps 409 config_etag_conflict to CONFLICT', async () => {
    agentMocks.updateAgent.mockRejectedValue(
      apiError(409, 'config_etag_conflict', 'Config changed')
    );
    const caller = await createCallerForUser(personalUser.id);

    await expect(
      caller.kiloclaw.updateAgent({ agentId: 'work', patch: { set: { thinkingDefault: 'high' } } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps 501 capability_unavailable to NOT_FOUND (needs redeploy)', async () => {
    agentMocks.createAgent.mockRejectedValue(
      apiError(501, 'capability_unavailable', 'Controller lacks config.agents.create.basic.cli')
    );
    const caller = await createCallerForUser(personalUser.id);

    await expect(
      caller.kiloclaw.createAgent({ name: 'Work', workspace: '/home/agents/work' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps 422 invalid_agent_config to BAD_REQUEST', async () => {
    agentMocks.updateAgentDefaults.mockRejectedValue(
      apiError(422, 'invalid_agent_config', 'Invalid config after patch')
    );
    const caller = await createCallerForUser(personalUser.id);

    await expect(
      caller.kiloclaw.updateAgentDefaults({ set: { thinkingDefault: 'low' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('kiloclaw agent procedures (org namespace)', () => {
  it('listAgents delegates for an org instance', async () => {
    agentMocks.listAgents.mockResolvedValue(LIST_RESPONSE);
    const caller = await createCallerForUser(orgOwner.id);

    const result = await caller.organizations.kiloclaw.listAgents({ organizationId: orgId });

    expect(result).toEqual(LIST_RESPONSE);
    expect(agentMocks.listAgents.mock.calls[0][0]).toBe(orgOwner.id);
  });

  it('createAgent forwards input.agent for an org instance', async () => {
    agentMocks.createAgent.mockResolvedValue({
      ok: true,
      etag: 'e1',
      agent: AGENT_SUMMARY,
      created: { agentId: 'work', name: 'Work', workspace: '/home/agents/work', agentDir: '/s' },
    });
    const caller = await createCallerForUser(orgOwner.id);

    await caller.organizations.kiloclaw.createAgent({
      organizationId: orgId,
      agent: { name: 'Work', workspace: '/home/agents/work' },
    });

    expect(agentMocks.createAgent.mock.calls[0][1]).toEqual({
      name: 'Work',
      workspace: '/home/agents/work',
    });
  });

  it('maps 409 config_etag_conflict to CONFLICT in the org namespace', async () => {
    agentMocks.updateAgent.mockRejectedValue(
      apiError(409, 'config_etag_conflict', 'Config changed')
    );
    const caller = await createCallerForUser(orgOwner.id);

    await expect(
      caller.organizations.kiloclaw.updateAgent({
        organizationId: orgId,
        agentId: 'work',
        patch: { set: { thinkingDefault: 'high' } },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns NOT_FOUND when the org has no active instance', async () => {
    // personalUser is not a member with an org instance under a fresh org id.
    const otherOrg = await createTestOrganization('No Instance Org', orgOwner.id, 1_000_000);
    const caller = await createCallerForUser(orgOwner.id);

    await expect(
      caller.organizations.kiloclaw.listAgents({ organizationId: otherOrg.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(agentMocks.listAgents).not.toHaveBeenCalled();
  });
});
