import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import type {
  ControlPlaneControlResult,
  ControlPlaneKiloRequestInput,
} from '../../shared/control-plane-protocol.js';
import { SandboxSessionV2 } from './session-do.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';

type NativeRequestUnit = {
  initialized: Promise<void>;
  sessionId: string;
  registration: unknown;
  route: unknown;
  sandboxPeer: () => unknown;
  sandboxPeerFor?: (sandboxId: string) => unknown;
  kiloRequest: (operation: { name: string }) => Promise<ControlPlaneControlResult>;
};

/**
 * Unit-level seam test for the Session DO native read. The route identity must
 * come from the DO's own registration and a stopped route must never prepare.
 */
function unit(overrides: { routeState?: 'ready' | 'unknown' | 'failed'; peer?: unknown }) {
  const session = Object.create(SandboxSessionV2.prototype) as NativeRequestUnit;
  session.initialized = Promise.resolve();
  session.sessionId = SESSION_ID;
  session.registration = {
    sandboxId: SANDBOX_ID,
    spec: {
      kiloSessionId: KILO_SESSION_ID,
      directory: '/workspace/private/root',
    },
  };
  session.route = { state: overrides.routeState ?? 'ready', attemptId: 'attempt_1' };
  session.sandboxPeer = () => overrides.peer ?? null;
  return session;
}

describe('SandboxSessionV2.kiloRequest', () => {
  it('forwards an allowlisted read using the registered route identity', async () => {
    const kiloRequest = vi.fn(
      async (_input: ControlPlaneKiloRequestInput): Promise<ControlPlaneControlResult> => ({
        ok: true,
        result: [{ id: 'todo_1', content: 'x', status: 'pending', priority: 'low' }],
      })
    );
    const session = unit({ peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'session.todo' })).resolves.toMatchObject({
      ok: true,
    });
    // The caller names only the operation. Neither a session id, directory, nor
    // URL is accepted, so a caller cannot reach a sibling route.
    expect(kiloRequest).toHaveBeenCalledWith({
      session: {
        sessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        directory: '/workspace/private/root',
      },
      operation: { name: 'session.todo' },
    });
  });

  it('returns not_ready for a stopped route without waking compute', async () => {
    const kiloRequest = vi.fn();
    const session = unit({ routeState: 'unknown', peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'session.status' })).resolves.toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Live runtime is not ready', retryable: true },
    });
    expect(kiloRequest).not.toHaveBeenCalled();
  });

  it('returns not_found without a registration', async () => {
    const session = unit({});
    session.registration = null;
    await expect(session.kiloRequest({ name: 'session.get' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects an operation outside the allowlist', async () => {
    const kiloRequest = vi.fn();
    const session = unit({ peer: { kiloRequest } });
    await expect(session.kiloRequest({ name: 'shell.exec' } as never)).rejects.toBeTruthy();
    expect(kiloRequest).not.toHaveBeenCalled();
  });
});
