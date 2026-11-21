import { type Href } from 'expo-router';

/**
 * The Bitbucket connect sheet (`app/(app)/bitbucket-connect.tsx`), as the href
 * every entry point pushes: the code reviewer's setup states, the new session
 * repository section, the PR review connect gate and the integrations hub.
 */
export function bitbucketConnectHref(scope: string): Href {
  return { pathname: '/(app)/bitbucket-connect', params: { scope } };
}
