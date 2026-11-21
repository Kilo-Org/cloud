import { useLocalSearchParams } from 'expo-router';

import { BitbucketConnectSheet } from '@/components/code-reviewer/bitbucket-connect-sheet';

export default function BitbucketConnectRoute() {
  const { scope } = useLocalSearchParams<{ scope?: string }>();
  // The param can be string | string[] depending on how the route was opened.
  const organizationId = Array.isArray(scope) ? scope[0] : scope;
  return <BitbucketConnectSheet scope={organizationId === '' ? undefined : organizationId} />;
}
