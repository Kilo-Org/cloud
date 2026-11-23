jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store') as object),
  evaluateStepUp: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/step-up-observation', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/admin/step-up-observation') as object),
  reportStepUpFailure: jest.fn(),
}));

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  StepUpRequiredError,
  type AdminStepUpState,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { stepUpOperationSchema } from '@kilocode/web-shared/lib/admin/step-up-binding';
import type { runStepUpGuard as RunStepUpGuard } from './step-up-guard';

const mockEvaluateStepUp = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).evaluateStepUp;
const mockReportStepUpFailure = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-observation') as {
    reportStepUpFailure: jest.Mock;
  }
).reportStepUpFailure;

let runStepUpGuard!: typeof RunStepUpGuard;

beforeAll(async () => {
  ({ runStepUpGuard } = await import('./step-up-guard'));
});

function params(overrides: Partial<Parameters<typeof RunStepUpGuard>[0]> = {}) {
  return {
    userId: 'user-1',
    credential: 'session' as const,
    webSessionId: 'session-1',
    actionClass: 'platform_read' as const,
    target: { kind: 'none' as const, id: null },
    enabled: true,
    route: 'admin.test',
    method: 'query',
    surface: 'trpc' as const,
    ...overrides,
  };
}

function freshState(): AdminStepUpState {
  return {
    status: 'fresh',
    method: 'webauthn_uv',
    verifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function causeOf(error: unknown): StepUpRequiredError | null {
  if (typeof error !== 'object' || error === null) return null;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof StepUpRequiredError ? cause : null;
}

async function refusal(promise: Promise<unknown>): Promise<StepUpRequiredError | null> {
  const error = await promise.then(
    () => null,
    (rejection: unknown) => rejection
  );
  return causeOf(error);
}

describe('runStepUpGuard', () => {
  beforeEach(() => {
    mockEvaluateStepUp.mockReset();
    mockReportStepUpFailure.mockClear();
  });

  it('does nothing and reads nothing when the switch is off', async () => {
    await expect(runStepUpGuard(params({ enabled: false }))).resolves.toEqual({
      status: 'absent',
    });
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
  });

  it('refuses a bearer credential without evaluating', async () => {
    const cause = await refusal(runStepUpGuard(params({ credential: 'human_bearer' })));

    expect(cause?.code).toBe('BEARER_NOT_ALLOWED');
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'required' }, 'MFA_REQUIRED'],
    [{ status: 'expired', verifiedAt: new Date().toISOString() }, 'MFA_EXPIRED'],
    [{ status: 'revoked', verifiedAt: new Date().toISOString() }, 'MFA_EXPIRED'],
    [{ status: 'not_enrolled' }, 'NOT_ENROLLED'],
    [{ status: 'session_unbound' }, 'SESSION_UNBOUND'],
  ] as const)('refuses %j as %s', async (state, code) => {
    mockEvaluateStepUp.mockResolvedValue({ state, proof: null, passkeyCount: 1 });

    const cause = await refusal(runStepUpGuard(params()));

    expect(cause?.code).toBe(code);
  });

  it('allows a fresh proof through', async () => {
    mockEvaluateStepUp.mockResolvedValue({
      state: freshState(),
      proof: null,
      passkeyCount: 1,
    });

    await expect(runStepUpGuard(params())).resolves.toMatchObject({ status: 'fresh' });
  });

  it('fails closed when the measurement fails', async () => {
    mockEvaluateStepUp.mockRejectedValue(new Error('relation does not exist'));

    const cause = await refusal(runStepUpGuard(params()));

    expect(cause?.code).toBe('STEP_UP_UNAVAILABLE');
    expect(mockReportStepUpFailure).toHaveBeenCalledWith(
      'admin_step_up_evaluate',
      expect.any(Error)
    );
  });

  it('passes the exact operation to the evaluation', async () => {
    mockEvaluateStepUp.mockResolvedValue({
      state: freshState(),
      proof: null,
      passkeyCount: 1,
    });

    await runStepUpGuard(
      params({
        actionClass: 'sensitive_write',
        target: { kind: 'user', id: 'target-user' },
        route: 'admin.users.update',
        method: 'mutation',
      })
    );

    expect(mockEvaluateStepUp).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClass: 'sensitive_write',
        operation: {
          surface: 'trpc',
          route: 'admin.users.update',
          method: 'mutation',
          target: { kind: 'user', id: 'target-user' },
        },
      })
    );
  });

  it('carries the operation binding on an operation-class refusal', async () => {
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    });

    const cause = await refusal(
      runStepUpGuard(
        params({
          actionClass: 'support_write',
          target: { kind: 'organization', id: 'org-1' },
          route: 'admin.supportAccess.request',
          method: 'mutation',
        })
      )
    );

    expect(cause).toMatchObject({
      code: 'MFA_REQUIRED',
      actionClass: 'support_write',
      purpose: 'operation',
      maxAgeSeconds: 300,
      binding: {
        actionClass: 'support_write',
        surface: 'trpc',
        route: 'admin.supportAccess.request',
        method: 'mutation',
        targetKind: 'organization',
        targetId: 'org-1',
      },
    });
    // The admin UI echoes this value back and the challenge endpoint parses it
    // with the same schema, so a refusal that fails it is a dead end.
    expect(stepUpOperationSchema.safeParse(cause?.binding).success).toBe(true);
  });

  it('carries no binding on a session-class refusal', async () => {
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    });

    const cause = await refusal(runStepUpGuard(params({ actionClass: 'platform_read' })));

    expect(cause).toMatchObject({
      purpose: 'session',
      maxAgeSeconds: 1800,
      binding: null,
    });
  });

  it.each([
    ['route', { route: null }],
    ['method', { method: null }],
    ['route', { route: '' }],
    ['route', { route: 'x'.repeat(1025) }],
    ['method', { method: 'y'.repeat(17) }],
  ] as const)(
    'fails closed when an operation class cannot name its %s',
    async (_field, override) => {
      // A refusal binding is echoed back by the admin UI and parsed with the
      // binding schema, which bounds the route and the method. A request whose
      // operation cannot produce a submittable binding would leave the caller
      // with a prompt it can never satisfy, so it is a wiring error.
      mockEvaluateStepUp.mockResolvedValue({
        state: { status: 'required' },
        proof: null,
        passkeyCount: 1,
      });

      await expect(
        runStepUpGuard(
          params({
            actionClass: 'support_write',
            target: { kind: 'organization', id: 'org-1' },
            ...override,
          })
        )
      ).rejects.toThrow('An operation step-up binding must be one the client can submit');
      expect(mockEvaluateStepUp).not.toHaveBeenCalled();
      expect(mockReportStepUpFailure).not.toHaveBeenCalled();
    }
  );

  it('still refuses a session class that cannot name its route and method', async () => {
    // A session proof is not bound to an operation, so nothing about its
    // refusal needs the route or the method.
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    });

    const cause = await refusal(
      runStepUpGuard(params({ actionClass: 'platform_read', route: null, method: null }))
    );

    expect(cause).toMatchObject({ code: 'MFA_REQUIRED', purpose: 'session', binding: null });
  });
});
