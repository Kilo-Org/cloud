import { type Href } from 'expo-router';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import {
  PICKER_LAUNCH_CONTEXT_TTL_MS,
  type PickerLaunchContext,
} from '@/lib/agent-attachments/picker-launch-context';

/**
 * The route segments `useSegments()` reports before the app reaches its tab
 * view: the `(app)` layout on its own, which is the index route that redirects
 * to the opening tab. A start there is the same start as the tab itself.
 */
const APP_INDEX_SEGMENTS: readonly string[] = ['(app)'];

/** The route segments `useSegments()` reports for the tab the app opens on. */
const APP_HOME_SEGMENTS: readonly string[] = ['(app)', '(tabs)', '(0_home)'];

/**
 * True while the app is on the route it opens on, with no screen pushed over
 * it. Any other start route came from a deep link or a deliberate navigation,
 * where the person is already where they asked to be.
 */
export function isAppLandingSegments(segments: readonly string[]): boolean {
  const expected =
    segments.length === APP_INDEX_SEGMENTS.length ? APP_INDEX_SEGMENTS : APP_HOME_SEGMENTS;
  if (segments.length !== expected.length) {
    return false;
  }
  return segments.every((segment, index) => segment === expected[index]);
}

/**
 * The composer route a stored picker launch has to come back to, or null when
 * the launch does not need one.
 *
 * Android can recreate the Activity while a camera or library picker is in
 * front, which rebuilds the app on its opening route and drops the composer
 * that launched the picker. The launch context is written right before every
 * such launch and normally cleared as soon as the composer sees the result, so
 * a context that is still here at start belongs to a composer that did not
 * survive.
 *
 * The two agent composers come back: the new-session form with its durable
 * draft, and the session it was started from. The picture entry is left alone
 * because it launches from that opening route itself, so its launch returning
 * there is already where the person was, and its own recovery opens the
 * composer with the picture.
 */
export function resolvePickerLaunchRestorePath(input: {
  readonly context: PickerLaunchContext | null;
  readonly userId: string | undefined;
  readonly now: number;
  readonly atLandingRoute: boolean;
}): Href | null {
  const { context, userId, now, atLandingRoute } = input;
  if (context === null || !atLandingRoute) {
    return null;
  }
  if (context.surface !== 'agent-new' && context.surface !== 'agent-chat') {
    return null;
  }
  // The identity can still be empty while the app starts. Waiting for it keeps
  // another account's context from opening on this one.
  if (userId === undefined || context.userId !== userId) {
    return null;
  }
  if (now - context.launchedAt > PICKER_LAUNCH_CONTEXT_TTL_MS) {
    return null;
  }
  if (context.surface === 'agent-new') {
    // The path builder returns a plain string; typed routes accept the same
    // route as `Href` at its call sites, so the cast stays here once.
    return getNewAgentSessionPath(context.organizationId) as Href;
  }
  if (context.sessionId === null) {
    return null;
  }
  return getAgentSessionPath(context.sessionId, context.organizationId ?? undefined);
}
