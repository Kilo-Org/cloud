import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';

jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store') as object;
  return { ...actual, evaluateStepUp: jest.fn() };
});

import type { supportStepUpPort as SupportStepUpPortValue } from '@kilocode/web-shared/lib/admin/support-step-up';

let supportStepUpPort: typeof SupportStepUpPortValue;
beforeAll(async () => {
  ({ supportStepUpPort } = await import('@kilocode/web-shared/lib/admin/support-step-up'));
});

const mockedEvaluate = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).evaluateStepUp;
const originalAdminStepUp = process.env.ADMIN_STEP_UP_ENABLED;

function requireFresh(credential?: 'session' | 'human_bearer') {
  return supportStepUpPort.requireFresh({
    userId: 'user-1',
    action: 'support_write_request',
    credential,
    webSessionId: 'session-1',
    route: 'admin.supportAccess.request',
    method: 'mutation',
    surface: 'trpc',
  });
}

async function stepUpCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    const cause = (error as TRPCError).cause;
    return cause instanceof StepUpRequiredError ? cause.code : undefined;
  }
}

describe('support step-up adapter', () => {
  beforeEach(() => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockedEvaluate.mockReset();
  });

  afterEach(() => {
    if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
  });

  test('a missing credential is treated as non-session', async () => {
    expect(await stepUpCode(requireFresh())).toBe('BEARER_NOT_ALLOWED');
    expect(mockedEvaluate).not.toHaveBeenCalled();
  });

  test('a bearer credential is refused before evaluation', async () => {
    expect(await stepUpCode(requireFresh('human_bearer'))).toBe('BEARER_NOT_ALLOWED');
    expect(mockedEvaluate).not.toHaveBeenCalled();
  });

  test('a stale or missing proof is MFA_REQUIRED', async () => {
    mockedEvaluate.mockResolvedValue({ state: { status: 'required' } } as never);
    expect(await stepUpCode(requireFresh('session'))).toBe('MFA_REQUIRED');
  });

  test('an evaluation failure fails closed as STEP_UP_UNAVAILABLE', async () => {
    mockedEvaluate.mockRejectedValue(new Error('db down'));
    expect(await stepUpCode(requireFresh('session'))).toBe('STEP_UP_UNAVAILABLE');
  });

  test('step-up disabled refuses write authority with MFA_REQUIRED', async () => {
    delete process.env.ADMIN_STEP_UP_ENABLED;
    expect(await stepUpCode(requireFresh('session'))).toBe('MFA_REQUIRED');
    expect(mockedEvaluate).not.toHaveBeenCalled();
  });
});
