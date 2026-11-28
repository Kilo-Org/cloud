import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import type { SupportActionClass } from '@kilocode/web-shared/lib/admin/support-access';

jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store') as object;
  return { ...actual, evaluateStepUp: jest.fn() };
});

import type {
  requireSupportWriteUseStepUp as RequireSupportWriteUseStepUpValue,
  supportStepUpCredential as SupportStepUpCredentialValue,
  supportStepUpPort as SupportStepUpPortValue,
} from '@kilocode/web-shared/lib/admin/support-step-up';
import type { staffRefusalKind as StaffRefusalKindValue } from '@kilocode/web-shared/lib/admin/admin-guard';

let supportStepUpPort: typeof SupportStepUpPortValue;
let requireSupportWriteUseStepUp: typeof RequireSupportWriteUseStepUpValue;
let supportStepUpCredential: typeof SupportStepUpCredentialValue;
let staffRefusalKind: typeof StaffRefusalKindValue;
beforeAll(async () => {
  ({ requireSupportWriteUseStepUp, supportStepUpCredential, supportStepUpPort } =
    await import('@kilocode/web-shared/lib/admin/support-step-up'));
  ({ staffRefusalKind } = await import('@kilocode/web-shared/lib/admin/admin-guard'));
});

const mockedEvaluate = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).evaluateStepUp;
const originalAdminStepUp = process.env.ADMIN_STEP_UP_ENABLED;

function requireFresh(
  credential?: 'session' | 'human_bearer',
  actionClass: SupportActionClass = 'support_write'
) {
  return supportStepUpPort.requireFresh({
    userId: 'user-1',
    action: 'support_write_request',
    actionClass,
    organizationId: 'organization-1',
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

  test('binds the proof to the organization it acts on', async () => {
    mockedEvaluate.mockResolvedValue({ state: { status: 'required' } } as never);
    await stepUpCode(requireFresh('session'));

    expect(mockedEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClass: 'support_write',
        operation: {
          surface: 'trpc',
          route: 'admin.supportAccess.request',
          method: 'mutation',
          target: { kind: 'organization', id: 'organization-1' },
        },
      })
    );
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

  test('step-up disabled skips the read-class requirement', async () => {
    delete process.env.ADMIN_STEP_UP_ENABLED;
    await expect(requireFresh('session', 'support_read')).resolves.toBeUndefined();
    expect(mockedEvaluate).not.toHaveBeenCalled();
  });

  test('a read-class request needs only a session proof', async () => {
    mockedEvaluate.mockResolvedValue({ state: { status: 'fresh' } } as never);
    await expect(requireFresh('session', 'support_read')).resolves.toBeUndefined();
    expect(mockedEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ actionClass: 'support_read' })
    );
  });
});

describe('support write use', () => {
  const freshUpstreamState = {
    status: 'fresh' as const,
    method: 'webauthn_uv' as const,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
  };

  beforeEach(() => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockedEvaluate.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
  });

  test('a support write use needs a decision for its own class and organization', async () => {
    const requireFreshSpy = jest
      .spyOn(supportStepUpPort, 'requireFresh')
      .mockResolvedValue(undefined as never);

    await requireSupportWriteUseStepUp({
      userId: 'user-1',
      organizationId: 'organization-1',
      upstreamStepUpState: freshUpstreamState,
      upstreamStepUpDecision: { actionClass: 'platform_write', target: { kind: 'none', id: null } },
      credential: 'session',
      webSessionId: 'session-1',
    });

    expect(requireFreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClass: 'support_write',
        organizationId: 'organization-1',
      })
    );
  });

  test('a matching support write decision is reused without a new evaluation', async () => {
    const requireFreshSpy = jest
      .spyOn(supportStepUpPort, 'requireFresh')
      .mockResolvedValue(undefined as never);

    await expect(
      requireSupportWriteUseStepUp({
        userId: 'user-1',
        organizationId: 'organization-1',
        upstreamStepUpState: freshUpstreamState,
        upstreamStepUpDecision: {
          actionClass: 'support_write',
          target: { kind: 'organization', id: 'organization-1' },
        },
        credential: 'session',
        webSessionId: 'session-1',
      })
    ).resolves.toBe(true);

    expect(requireFreshSpy).not.toHaveBeenCalled();
  });
});

describe('support step-up credential', () => {
  afterEach(() => {
    if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
  });

  test.each(['true', 'false'])(
    'a UTS browser session is refused by name with step-up %s',
    enabled => {
      process.env.ADMIN_STEP_UP_ENABLED = enabled;
      let refusal: unknown;
      try {
        supportStepUpCredential('uts_session');
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(TRPCError);
      expect((refusal as TRPCError).code).toBe('FORBIDDEN');
      expect(staffRefusalKind(refusal)).toBe('uts_session');
    }
  );

  test('every other credential passes unchanged', () => {
    expect(supportStepUpCredential('session')).toBe('session');
    expect(supportStepUpCredential('human_bearer')).toBe('human_bearer');
    expect(supportStepUpCredential('delegated_workload')).toBe('delegated_workload');
    expect(supportStepUpCredential('service_assertion')).toBe('service_assertion');
    expect(supportStepUpCredential(undefined)).toBeUndefined();
  });
});
