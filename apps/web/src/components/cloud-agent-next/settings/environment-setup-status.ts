import { isOpenSetupRunStatus } from '@kilocode/cloud-agent-profile';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';

export function hasOpenSetupRun(runs: readonly SetupRunResponse[] | undefined): boolean {
  return runs?.some(run => isOpenSetupRunStatus(run.status)) ?? false;
}
