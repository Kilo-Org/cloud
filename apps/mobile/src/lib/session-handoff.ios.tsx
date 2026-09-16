import Head from 'expo-router/head';
import { type ReactNode } from 'react';

import { buildSessionHandoff, type SessionHandoffAdvertiserProps } from './session-handoff-payload';

/**
 * iOS advertises the session as an `NSUserActivity`, which is what feeds
 * Handoff and the app icon in another device's app switcher.
 *
 * The native half ships with expo-router, so this file is the whole iOS
 * implementation: `expo-router/head`'s default `Head` reads its `<title>` and
 * `<meta>` children and calls
 * `ExpoHead.createActivity({ webpageURL, title, isEligibleForHandoff, ... })`
 * followed by `becomeCurrent()`. `expo:handoff` is what turns
 * `isEligibleForHandoff` on — without it the activity is never registered. The
 * meta children never reach the native view tree: `useMetaChildren` filters
 * host children out of what is rendered.
 *
 * `Head` always resolves the fallback URL through `extra.router.headOrigin`
 * (see the asserted value in `app.config.ts`), and it reports the position back
 * as `userInfo.href`, the router href including its search params.
 */
export function SessionHandoffAdvertiser({
  sessionId,
  anchorMessageId,
  title,
}: SessionHandoffAdvertiserProps): ReactNode {
  const { url } = buildSessionHandoff({ sessionId, anchorMessageId, title });

  if (url === null) {
    return null;
  }

  return (
    <Head>
      <title>{title}</title>
      <meta property="og:url" content={url} />
      <meta property="og:description" content={title} />
      <meta property="expo:handoff" content="true" />
    </Head>
  );
}
