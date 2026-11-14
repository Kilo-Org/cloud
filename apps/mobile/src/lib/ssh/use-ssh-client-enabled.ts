import { SSH_CLIENT_FLAG } from '@kilocode/app-shared/feature-flags';

import { useFeatureFlag } from '@/lib/analytics/posthog';

import { useSshFixtureFlag } from './fixture-flag';

export function useSshClientEnabled(): boolean {
  const remoteFlag = useFeatureFlag(SSH_CLIENT_FLAG, false);
  const fixtureFlag = useSshFixtureFlag();
  return remoteFlag || fixtureFlag;
}
