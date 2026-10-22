/* eslint-disable require-await, @typescript-eslint/require-await -- the fake deps settle immediately; the callbacks exist only to be asserted */
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  prepareAgentSession,
  type PrepareAgentSessionDeps,
  type PrepareAgentSessionInput,
} from './prepare-agent-session';

const SESSION_ID = 'ses_12345678901234567890123456';

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const prepareSessionOrganizationMutate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: {
      cloudAgentNext: { prepareSession: { mutate: prepareSessionOrganizationMutate } },
    },
  },
  useTRPC: () => ({}),
}));

// Mirror of the real retryability predicate (covered by its own suite); the
// module itself reaches React Native, which this project cannot load. Only the
// terminal `BAD_REQUEST` shape below is used by these tests.
vi.mock('@/components/agents/mobile-session-manager', () => {
  const TRANSIENT_CODES: Record<string, true> = {
    INTERNAL_SERVER_ERROR: true,
    BAD_GATEWAY: true,
    SERVICE_UNAVAILABLE: true,
    GATEWAY_TIMEOUT: true,
    TIMEOUT: true,
    TOO_MANY_REQUESTS: true,
  };
  return {
    isCloudPrepareRetryableError: (error: unknown): boolean => {
      if (typeof error !== 'object' || error === null || !('data' in error)) {
        return true;
      }
      const { data } = error;
      if (typeof data !== 'object' || data === null || !('code' in data)) {
        return true;
      }
      return typeof data.code === 'string' && TRANSIENT_CODES[data.code] === true;
    },
  };
});

const INTENT: PrepareAgentSessionInput = {
  kind: 'new',
  prompt: 'Fix the flaky test',
  mode: 'code',
  model: 'anthropic/claude',
  autoCommit: false,
};

/** A terminal `prepareSession` rejection: a typed code the user cannot retry. */
function terminalError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

/** The deps whose calls the assertions read. */
type CleanupSpies = {
  getKey: Mock<(fingerprint: string) => string>;
  rotateKey: Mock<() => void>;
  removeOutboxRow: Mock<(fingerprint: string) => Promise<void>>;
  invalidate: Mock<() => Promise<void>>;
};

function createDeps(): PrepareAgentSessionDeps & CleanupSpies {
  return {
    getKey: vi.fn(() => 'operation-key-1'),
    rotateKey: vi.fn(),
    getStoredOperationKey: vi.fn(() => null),
    writeSafeRetry: vi.fn(async () => undefined),
    removeOutboxRow: vi.fn(async () => undefined),
    whenLoaded: vi.fn(async () => true),
    invalidate: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareSessionMutate.mockResolvedValue({ kiloSessionId: SESSION_ID });
  prepareSessionOrganizationMutate.mockResolvedValue({ kiloSessionId: SESSION_ID });
});

describe('prepareAgentSession post-create cleanup', () => {
  it('reports the created session when the post-create outbox cleanup rejects', async () => {
    const deps = createDeps();
    deps.removeOutboxRow.mockRejectedValue(new Error('sqlcipher_busy'));

    const outcome = await prepareAgentSession(INTENT, deps);

    expect(outcome).toEqual({ ok: true, sessionId: SESSION_ID });
    expect(deps.rotateKey).toHaveBeenCalledOnce();
    expect(deps.invalidate).toHaveBeenCalledOnce();
  });

  it('rotates the key before the cleanup that fails', async () => {
    const deps = createDeps();
    const order: string[] = [];
    deps.rotateKey.mockImplementation(() => {
      order.push('rotateKey');
    });
    deps.removeOutboxRow.mockImplementation(async () => {
      order.push('removeOutboxRow');
      throw new Error('sqlcipher_busy');
    });

    await prepareAgentSession(INTENT, deps);

    expect(order).toEqual(['rotateKey', 'removeOutboxRow']);
  });

  it('returns the classified create failure when the failure handler cleanup rejects', async () => {
    const deps = createDeps();
    const rejection = terminalError();
    prepareSessionMutate.mockRejectedValue(rejection);
    deps.removeOutboxRow.mockRejectedValue(new Error('sqlcipher_busy'));

    const outcome = await prepareAgentSession(INTENT, deps);

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'prepare-failed',
      retryable: false,
      error: rejection,
    });
    expect(deps.rotateKey).toHaveBeenCalledOnce();
  });
});
