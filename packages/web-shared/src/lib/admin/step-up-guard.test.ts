import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store') as object),
  evaluateStepUp: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/step-up-observation', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/admin/step-up-observation') as object),
  emitStepUpObservation: jest.fn(),
  reportStepUpFailure: jest.fn(),
}));

const mockEvaluate = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }
).evaluateStepUp;
const mockReport = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-observation') as {
    reportStepUpFailure: jest.Mock;
  }
).reportStepUpFailure;
const mockEmit = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-observation') as {
    emitStepUpObservation: jest.Mock;
  }
).emitStepUpObservation;

import type { runStepUpGuard as RunStepUpGuard } from './step-up-guard';
type Guard = typeof RunStepUpGuard;
let runStepUpGuard!: Guard;

beforeAll(async () => {
  ({ runStepUpGuard } = await import('./step-up-guard'));
});

function params(mode: 'observe' | 'enforce') {
  return {
    userId: 'user-1',
    credential: 'session' as const,
    webSessionId: 'session-1',
    actionClass: 'platform_read' as const,
    mode,
    route: 'admin.test',
    method: 'query',
    surface: 'trpc' as const,
  };
}

describe('runStepUpGuard', () => {
  it('does not deny an observe-mode request when the measurement fails', async () => {
    mockEvaluate.mockRejectedValue(new Error('relation does not exist'));
    mockReport.mockClear();

    const state = await runStepUpGuard(params('observe'));

    expect(state).toEqual({ status: 'absent' });
    expect(mockReport).toHaveBeenCalledWith('admin_step_up_evaluate', expect.any(Error));
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ errored: true }));
  });

  it('does not convert a measurement failure into an enforcement denial', async () => {
    mockEvaluate.mockRejectedValue(new Error('relation does not exist'));

    await expect(runStepUpGuard(params('enforce'))).resolves.toEqual({ status: 'absent' });
  });
});
