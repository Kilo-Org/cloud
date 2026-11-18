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
});
