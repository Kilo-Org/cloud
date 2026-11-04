import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { SandboxId, TRPCContext } from '../../types.js';
import { createSessionManagementHandlers } from './session-management.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

const USER_ID = 'user_owner';
const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';
const SANDBOX_ID: SandboxId = `ses-${'a'.repeat(48)}`;

const storedMetadata: SessionMetadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: SESSION_ID, userId: USER_ID },
  auth: { kiloSessionId: KILO_SESSION_ID },
  workspace: { sandboxId: SANDBOX_ID },
  lifecycle: { version: 1, timestamp: 1_760_000_000_000 },
  profile: {
    runtimeAgents: [
      {
        slug: 'reviewer',
        name: 'Reviewer',
        config: { mode: 'subagent', model: 'anthropic/claude-sonnet-4-5', hidden: false },
      },
      {
        slug: 'triage',
        name: 'Triage',
        config: { mode: 'primary', hidden: true, disable: true },
      },
    ],
  },
};

const router = t.router({ getSession: createSessionManagementHandlers().getSession });

function setup() {
  const stub = {
    getMetadata: vi.fn().mockResolvedValue(storedMetadata),
    getSession: vi.fn().mockResolvedValue({ type: 'session-not-found' }),
  };
  const sandboxSessions = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  const context = {
    userId: USER_ID,
    authToken: 'test-auth-token',
    request: new Request('https://worker.test/trpc/getSession'),
    env: {
      SANDBOX_SESSION: sandboxSessions,
    },
  } as unknown as TRPCContext;
  return { stub, caller: router.createCaller(context) };
}

describe('getSession runtime agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: KILO_SESSION_ID,
      organizationId: null,
    });
  });

  it('projects stored mode, hidden and disable while retaining subagents', async () => {
    const { caller, stub } = setup();

    const result = await caller.getSession({ cloudAgentSessionId: SESSION_ID });

    expect(stub.getMetadata).toHaveBeenCalledTimes(1);
    expect(result.runtimeAgents).toHaveLength(2);
    expect(result.runtimeAgents?.[0]).toMatchObject({
      slug: 'reviewer',
      name: 'Reviewer',
      mode: 'subagent',
      hidden: false,
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(result.runtimeAgents?.[1]).toMatchObject({
      slug: 'triage',
      name: 'Triage',
      mode: 'primary',
      hidden: true,
      disable: true,
    });
  });
});
