import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BalanceValidationModule from '../../balance-validation.js';
import type { Env, TRPCContext } from '../../types.js';

const { validateBalanceOnly } = vi.hoisted(() => ({ validateBalanceOnly: vi.fn() }));

vi.mock('../../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  validateBalanceOnly,
}));

import { router } from '../auth.js';
import { getAnalysisCreditAdmission } from './analysis-credit-admission.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const env = { KILOCODE_BACKEND_BASE_URL: 'https://backend.test' } as Env;

function callerFor() {
  return router({ getAnalysisCreditAdmission }).createCaller({
    env,
    userId: 'user-1',
    authToken: 'control-token',
    request: new Request('http://worker.test/trpc/getAnalysisCreditAdmission'),
  } satisfies TRPCContext);
}

describe('getAnalysisCreditAdmission', () => {
  beforeEach(() => {
    validateBalanceOnly.mockReset();
  });

  it('admits when the balance check succeeds', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    await expect(
      callerFor().getAnalysisCreditAdmission({ organizationId: ORGANIZATION_ID })
    ).resolves.toEqual({ outcome: 'admitted' });
  });

  it('reports insufficient credits with the balance rejection message', async () => {
    validateBalanceOnly.mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits: $1 minimum required',
    });

    await expect(
      callerFor().getAnalysisCreditAdmission({ organizationId: ORGANIZATION_ID })
    ).resolves.toEqual({
      outcome: 'insufficient_credits',
      message: 'Insufficient credits: $1 minimum required',
    });
  });

  it('reports unavailable when the balance check cannot be completed', async () => {
    validateBalanceOnly.mockResolvedValue({
      success: false,
      status: 500,
      message: 'Failed to verify balance',
    });

    await expect(
      callerFor().getAnalysisCreditAdmission({ organizationId: ORGANIZATION_ID })
    ).resolves.toEqual({ outcome: 'unavailable', message: 'Failed to verify balance' });
  });

  it('forwards the organization id as the second argument to the balance check', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    await callerFor().getAnalysisCreditAdmission({ organizationId: ORGANIZATION_ID });

    expect(validateBalanceOnly).toHaveBeenCalledWith('control-token', ORGANIZATION_ID, env);
  });

  it('checks the personal balance when no organization is named', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    await callerFor().getAnalysisCreditAdmission({});

    expect(validateBalanceOnly).toHaveBeenCalledWith('control-token', undefined, env);
  });
});
