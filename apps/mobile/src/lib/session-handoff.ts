import { type ReactNode } from 'react';
import { Platform } from 'react-native';

import { SessionHandoffAdvertiser as AndroidSessionHandoffAdvertiser } from './session-handoff.android';
import { SessionHandoffAdvertiser as IosSessionHandoffAdvertiser } from './session-handoff.ios';
import { type SessionHandoffAdvertiserProps } from './session-handoff-payload';

export type { SessionHandoffAdvertiserProps } from './session-handoff-payload';

/**
 * The one component a session screen renders. The platform halves share the
 * payload and the props but not the mechanism — iOS advertises through
 * `NSUserActivity`, Android through its own launcher entry point — so the fork
 * lives here and the call site stays platform-free.
 *
 * Metro resolves a bare `@/lib/session-handoff` import to the platform file
 * first, so on device this module is usually bypassed; the branch below is what
 * a consumer of the shared file gets, and both routes yield the same component.
 */
export const SessionHandoffAdvertiser: (props: SessionHandoffAdvertiserProps) => ReactNode =
  Platform.OS === 'ios' ? IosSessionHandoffAdvertiser : AndroidSessionHandoffAdvertiser;
