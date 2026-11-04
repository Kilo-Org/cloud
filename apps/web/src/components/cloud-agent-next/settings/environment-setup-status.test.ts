import { describe, expect, it } from '@jest/globals';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { hasOpenSetupRun } from './environment-setup-status';

function run(status: SetupRunResponse['status']): SetupRunResponse {
  return { status } as SetupRunResponse;
}

describe('hasOpenSetupRun', () => {
  it('is false before the runs are known', () => {
    expect(hasOpenSetupRun(undefined)).toBe(false);
  });

  it('is false when every run is finished', () => {
    expect(hasOpenSetupRun([run('published'), run('reverted'), run('cancelled')])).toBe(false);
  });

  it('is true when a run still needs the user or the agent', () => {
    expect(hasOpenSetupRun([run('published'), run('needs_input')])).toBe(true);
    expect(hasOpenSetupRun([run('running')])).toBe(true);
  });
});
